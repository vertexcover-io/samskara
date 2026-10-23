import { createHash } from "node:crypto"
import { resolve } from "node:path"
import type {
  NormalizedMessage,
  ParsedRecord,
  ProjectIdentity,
  ToolResultMetadata,
} from "../../ingest/types.js"
import type {
  CodexHistory,
  CodexHistoryReader,
  CodexItemEntry,
  CodexThread,
  CodexTurn,
} from "../codex-history.js"
import { uuidV5 } from "../helpers.js"
import { redactJson } from "../redact.js"
import type {
  AgentPlugin,
  CheckpointBody,
  CheckpointStore,
  CodexCheckpoint,
  SessionBatch,
  SessionTrack,
} from "../types.js"

const NAMESPACE = "6ba7b811-9dad-11d1-80b4-00c04fd430c8"
const TOOL_TYPES = [
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "dynamicToolCall",
  "collabAgentToolCall",
  "webSearch",
  "imageView",
  "imageGeneration",
  "sleep",
]
// Their input is fixed when they start, so the call can be sent before the result exists.
const EARLY_CALL_TYPES = ["commandExecution", "mcpToolCall", "dynamicToolCall"]
const TEXT_TYPES = ["agentMessage", "plan", "reasoning", "webSearch", "imageGeneration"]
const TERMINAL_STATUSES = ["completed", "failed", "declined", "interrupted"]
const objectOf = (value: unknown): Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? { ...value } : {}
const stringOf = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined
const arrayOf = (value: unknown): ReadonlyArray<unknown> => (Array.isArray(value) ? value : [])
const redactedEntry = (entry: CodexItemEntry): CodexItemEntry => {
  let input = entry.item.arguments
  if (typeof input === "string") {
    try {
      input = JSON.parse(input)
    } catch {
      /* Custom tool input need not be JSON. */
    }
  }
  const item = objectOf(
    redactJson({ ...entry.item, ...(input === undefined ? {} : { arguments: input }) }),
  )
  return { ...entry, item: { ...item, id: entry.item.id, type: entry.item.type } }
}
const stamp = (value: number | null | undefined): string | undefined =>
  value === null || value === undefined ? undefined : new Date(value).toISOString()
const invocationId = (threadId: string, entry: CodexItemEntry): string =>
  `codex:${uuidV5(NAMESPACE, JSON.stringify([threadId, entry.turnId, entry.item.id]))}`

type Context = { readonly history: CodexHistory; readonly sessionId: string }

const normalized = (entry: CodexItemEntry, context: Context): ReadonlyArray<NormalizedMessage> => {
  const { thread } = context.history
  const item = objectOf(redactJson(entry.item))
  const subagent = thread.id !== context.sessionId
  const common = {
    sessionId: context.sessionId,
    source: "codex" as const,
    sourceSchemaVersion: 1,
    trackId: subagent ? `agent:${thread.id}` : "main",
    cwd: stringOf(item.cwd) ?? thread.cwd,
    ...(subagent ? { agentId: thread.id } : {}),
    ...(stamp(entry.startedAtMs) ? { timestamp: stamp(entry.startedAtMs) } : {}),
  }
  const text = (value: string, subIndex = 0, reasoning = false): NormalizedMessage => ({
    ...common,
    subIndex,
    msgType: "message",
    role: "assistant",
    content: { type: reasoning ? "reasoning" : "text", value },
  })
  const custom = (): NormalizedMessage => ({
    ...common,
    subIndex: 0,
    msgType: "custom",
    subType: entry.item.type,
  })
  if (item.type === "userMessage") {
    return arrayOf(item.content).flatMap((part, subIndex): NormalizedMessage[] => {
      const input = objectOf(part)
      if (input.type === "text" && typeof input.text === "string")
        return [
          {
            ...common,
            subIndex,
            msgType: "message",
            role: "user",
            content: { type: "text", value: input.text },
          },
        ]
      const url = stringOf(input.url)
      if (input.type === "image" && url)
        return [
          {
            ...common,
            subIndex,
            msgType: "message",
            role: "user",
            content: {
              type: "image",
              value: url,
              mediaType: /^data:(image\/[^;,]+)/.exec(url)?.[1] ?? "application/octet-stream",
              encoding: "url",
            },
          },
        ]
      return [{ ...custom(), subIndex }]
    })
  }
  if (item.type === "agentMessage" || item.type === "plan")
    return [text(typeof item.text === "string" ? item.text : "")]
  if (item.type === "reasoning")
    return [
      text(
        [...arrayOf(item.summary), ...arrayOf(item.content)]
          .filter((part): part is string => typeof part === "string")
          .join("\n\n"),
        0,
        true,
      ),
    ]
  if (item.type === "hookPrompt")
    return arrayOf(item.fragments).map((fragment, subIndex) => ({
      ...common,
      subIndex,
      msgType: "message",
      role: "user",
      subType: "toolInjection",
      details: { isMeta: true },
      content: { type: "text", value: stringOf(objectOf(fragment).text) ?? "" },
    }))
  if (item.type === "contextCompaction")
    return [{ ...common, subIndex: 0, msgType: "compaction", details: { type: "boundary" } }]
  if (item.type === "turnCompleted") {
    // A separate observer may project an active external turn as interrupted.
    if (item.status === "interrupted" && item.completedAt === null) return [custom()]
    return [
      {
        ...common,
        subIndex: 0,
        msgType: "turnEvent",
        details: {
          type: item.status === "completed" ? "unknown" : "aborted",
          status: item.status === "completed" ? "completed" : "aborted",
          reason: stringOf(item.status),
        },
      },
    ]
  }
  if (!TOOL_TYPES.includes(entry.item.type)) return [custom()]
  const callId = invocationId(thread.id, entry)
  const name =
    item.type === "mcpToolCall"
      ? `mcp__${stringOf(item.server) ?? "unknown"}__${stringOf(item.tool) ?? "unknown"}`
      : (stringOf(item.tool) ?? entry.item.type)
  const shell = item.type === "commandExecution" ? stringOf(item.command) : undefined
  const call: NormalizedMessage = {
    ...common,
    subIndex: 0,
    msgType: "toolCall",
    details: {
      callId,
      name,
      input: item.arguments ?? (shell ? { command: shell, cwd: common.cwd } : item),
      ...(shell ? { metadata: { type: "shell", command: shell } } : {}),
    },
  }
  const failure =
    item.status === "failed" ||
    item.success === false ||
    (typeof item.exitCode === "number" && item.exitCode !== 0)
  const status = failure
    ? "failure"
    : item.status === "declined" || item.status === "interrupted"
      ? "cancelled"
      : item.status === "completed" || item.success === true
        ? "success"
        : "unknown"
  let metadata: ToolResultMetadata | undefined
  if (item.type === "fileChange" && item.status === "completed") {
    const files = arrayOf(item.changes).flatMap((value) => {
      const change = objectOf(value)
      const kind = objectOf(change.kind)
      const path = stringOf(kind.move_path) ?? stringOf(change.path)
      return !path || kind.type === "delete"
        ? []
        : [{ path: resolve(common.cwd, path), created: kind.type === "add" }]
    })
    metadata = { type: "writes", files }
  }
  return [
    call,
    {
      ...common,
      ...(stamp(entry.completedAtMs) ? { timestamp: stamp(entry.completedAtMs) } : {}),
      subIndex: 1,
      msgType: "toolResult",
      details: {
        callId,
        status,
        output:
          item.type === "commandExecution"
            ? (item.aggregatedOutput ?? "")
            : (item.result ?? item.error ?? item.contentItems ?? item),
        ...(metadata ? { metadata } : {}),
      },
    },
  ]
}

// A separate observer may project an active external turn as interrupted.
const turnEnded = (turn: CodexTurn | undefined): boolean =>
  turn !== undefined &&
  turn.status !== "inProgress" &&
  !(turn.status === "interrupted" && turn.completedAt == null)

const isComplete = (entry: CodexItemEntry, turn: CodexTurn | undefined): boolean => {
  if (turnEnded(turn)) return true
  const terminal = TERMINAL_STATUSES.includes(stringOf(entry.item.status) ?? "")
  if (TEXT_TYPES.includes(entry.item.type)) return terminal || Boolean(entry.completedAtMs)
  return terminal || !TOOL_TYPES.includes(entry.item.type)
}

const turnEvent = (turn: CodexTurn): CodexItemEntry => ({
  turnId: turn.id,
  item: {
    id: `turn:${turn.id}`,
    type: "turnCompleted",
    status: turn.status,
    completedAt: turn.completedAt ?? null,
  },
  ...(turn.completedAt == null ? {} : { startedAtMs: turn.completedAt * 1000 }),
})

const orderedEntries = (history: CodexHistory): ReadonlyArray<CodexItemEntry> => {
  const byTurn = new Map<string, CodexItemEntry[]>()
  for (const entry of history.items) {
    const items = byTurn.get(entry.turnId)
    if (items) items.push(entry)
    else byTurn.set(entry.turnId, [entry])
  }
  const turnIds = new Set(history.turns.map((turn) => turn.id))
  return [
    ...history.turns.flatMap((turn) => [
      ...(byTurn.get(turn.id) ?? []),
      ...(turnEnded(turn) ? [turnEvent(turn)] : []),
    ]),
    ...history.items.filter((entry) => !turnIds.has(entry.turnId)),
  ]
}

type Pointer = NonNullable<CodexCheckpoint["end"]>
type PendingItem = CodexCheckpoint["pending"][number]
type Seen = { readonly pointer: Pointer; readonly pending?: PendingItem }

const keyOf = (pointer: { readonly turnId: string; readonly itemId: string }): string =>
  JSON.stringify([pointer.turnId, pointer.itemId])

const codexCheckpoint = (store: CheckpointStore, threadId: string): CodexCheckpoint | undefined => {
  const checkpoint = store.checkpoints[`codex:${threadId}`]
  return checkpoint?.source === "codex" ? checkpoint : undefined
}

const buildTrack = (input: {
  readonly history: CodexHistory
  readonly family: ReadonlyArray<CodexHistory>
  readonly sessionId: string
  readonly project: ProjectIdentity
  readonly store: CheckpointStore
  readonly read: boolean
  readonly listedAt: number
}): SessionTrack => {
  const { history, sessionId, project, store } = input
  const { thread } = history
  const checkpointKey = `codex:${thread.id}`
  const prev = codexCheckpoint(store, thread.id)
  const turns = new Map(history.turns.map((turn) => [turn.id, turn]))
  const entries = orderedEntries(history).map(redactedEntry)
  const keys = entries.map((entry) => keyOf({ turnId: entry.turnId, itemId: entry.item.id }))
  const endIndex = prev?.end ? keys.indexOf(keyOf(prev.end)) : -1
  const waiting = new Map((prev?.pending ?? []).map((item) => [keyOf(item), item]))
  const finished = new Set<string>()
  const seen: Seen[] = []
  const records: ParsedRecord[] = []
  let ordinal = prev?.end?.ordinal ?? 0
  const emit = (
    entry: CodexItemEntry,
    lineNumber: number,
    keep: (message: NormalizedMessage) => boolean,
  ): void => {
    const [first, ...rest] = normalized(entry, { history, sessionId }).filter(keep)
    if (!first) return
    records.push({
      lineUuid: uuidV5(
        NAMESPACE,
        JSON.stringify(["codex", thread.id, entry.turnId, entry.item.id]),
      ),
      lineNumber,
      raw: redactJson(entry),
      messages: [first, ...rest],
    })
  }
  entries.forEach((entry, index) => {
    const key = keys[index] ?? ""
    const complete = isComplete(entry, turns.get(entry.turnId))
    const saved = waiting.get(key)
    if (saved) {
      if (!complete) return
      finished.add(key)
      emit(entry, saved.ordinal, (message) => !saved.partial || message.subIndex !== 0)
      return
    }
    if (index <= endIndex) return
    const pointer = { turnId: entry.turnId, itemId: entry.item.id, ordinal: ++ordinal }
    if (complete) {
      seen.push({ pointer })
      emit(entry, pointer.ordinal, () => true)
      return
    }
    const partial = EARLY_CALL_TYPES.includes(entry.item.type)
    seen.push({ pointer, pending: { ...pointer, partial } })
    if (partial) emit(entry, pointer.ordinal, (message) => message.subIndex === 0)
  })
  records.sort((left, right) => left.lineNumber - right.lineNumber)
  // A pending item whose turn is gone was rolled back. An unread thread has no turns to check.
  const kept = (prev?.pending ?? []).filter((item) => !input.read || turns.has(item.turnId))
  const sourceContext = {
    startedAt: new Date(thread.createdAt * 1000).toISOString(),
    lastActiveAt: new Date(thread.updatedAt * 1000).toISOString(),
    ...(thread.model ? { modelSnapshot: thread.model } : {}),
    ...(thread.modelProvider ? { provider: thread.modelProvider } : {}),
  }
  const parent = input.family.find((member) => member.thread.id === thread.parentThreadId)
  const spawn = parent?.items.find(
    (entry) =>
      entry.item.type === "collabAgentToolCall" &&
      entry.item.tool === "spawnAgent" &&
      arrayOf(entry.item.receiverThreadIds).includes(thread.id),
  )
  const spawnToolUseId =
    parent && spawn ? invocationId(parent.thread.id, spawn) : prev?.spawnToolUseId
  const agent = {
    agentId: thread.id,
    ...(thread.parentThreadId && thread.parentThreadId !== sessionId
      ? { parentAgentId: thread.parentThreadId }
      : {}),
    ...(thread.agentRole ? { agentType: thread.agentRole } : {}),
    ...(thread.agentNickname ? { description: thread.agentNickname } : {}),
    ...(spawnToolUseId ? { spawnToolUseId } : {}),
  }
  const metadataHash = createHash("sha256")
    .update(JSON.stringify({ sourceContext, name: thread.name, agent }))
    .digest("hex")
  const lastLineProcessed = ordinal
  const checkpointAt = (line: number): CheckpointBody => {
    const done = line >= lastLineProcessed
    const sent = seen.filter((item) => item.pointer.ordinal <= line)
    const end = sent.at(-1)?.pointer ?? prev?.end
    // updatedAt has whole-second resolution, so a write later in the second it was listed in
    // would leave it unchanged; such a thread is read once more next cycle.
    const settled = done && thread.updatedAt < input.listedAt
    return {
      source: "codex",
      threadId: thread.id,
      sessionId,
      metadataHash: done ? metadataHash : (prev?.metadataHash ?? ""),
      ...(spawnToolUseId ? { spawnToolUseId } : {}),
      updatedAt: settled ? thread.updatedAt : (prev?.updatedAt ?? 0),
      ...(end ? { end } : {}),
      pending: [
        ...kept.filter((item) => !(finished.has(keyOf(item)) && item.ordinal <= line)),
        ...sent.flatMap((item) => (item.pending ? [item.pending] : [])),
      ],
    }
  }
  const shared = {
    sessionId,
    source: "codex" as const,
    project,
    sourceRelativePath: `codex/${thread.id}`,
    records,
    checkpointKey,
    lastLineProcessed,
    checkpointAt,
  }
  if (thread.id !== sessionId) return { ...shared, type: "subagent", agent }
  return {
    ...shared,
    type: "main",
    sourceContext,
    startCwd: thread.cwd,
    ...(thread.gitInfo?.sha ? { startCommit: thread.gitInfo.sha } : {}),
    ...(thread.name || thread.preview ? { title: thread.name || thread.preview } : {}),
  }
}

const progressOf = (checkpoint: CheckpointBody): string =>
  checkpoint.source === "codex"
    ? JSON.stringify([
        checkpoint.updatedAt,
        checkpoint.metadataHash,
        checkpoint.end
          ? [checkpoint.end.turnId, checkpoint.end.itemId, checkpoint.end.ordinal]
          : null,
        checkpoint.pending.map((item) => [item.turnId, item.itemId, item.ordinal, item.partial]),
      ])
    : ""

const changed = (track: SessionTrack, store: CheckpointStore): boolean => {
  const prev = store.checkpoints[track.checkpointKey]
  return (
    track.records.length > 0 ||
    prev?.source !== "codex" ||
    progressOf(prev) !== progressOf(track.checkpointAt(track.lastLineProcessed))
  )
}

export const createCodexPlugin = ({
  reader,
  now = Date.now,
}: {
  readonly reader: CodexHistoryReader
  readonly now?: () => number
}): AgentPlugin => {
  const projectsByCwd = new Map<string, Promise<ProjectIdentity | null>>()
  return {
    source: "codex",
    close: () => reader.close(),
    collect: async (store, deps): Promise<ReadonlyArray<SessionBatch>> => {
      try {
        const listedAt = Math.floor(now() / 1000)
        const threads = await reader.listThreads()
        const children = new Map<string, CodexThread[]>()
        for (const thread of threads)
          if (thread.parentThreadId) {
            const siblings = children.get(thread.parentThreadId)
            if (siblings) siblings.push(thread)
            else children.set(thread.parentThreadId, [thread])
          }
        const roots = threads.filter((thread) => !thread.parentThreadId)
        const eligibleByCwd = new Map<
          string,
          Promise<{ project: ProjectIdentity; cutoff?: string } | null>
        >()
        const eligible = (
          cwd: string,
        ): Promise<{ project: ProjectIdentity; cutoff?: string } | null> => {
          const existing = eligibleByCwd.get(cwd)
          if (existing) return existing
          const result = (async () => {
            let identity = projectsByCwd.get(cwd)
            if (!identity) {
              identity = deps
                .resolveProject(cwd)
                .then((project) => project ?? store.projects?.[cwd] ?? null)
              projectsByCwd.set(cwd, identity)
            }
            const project = await identity.catch((error: unknown) => {
              projectsByCwd.delete(cwd)
              throw error
            })
            if (!project) {
              projectsByCwd.delete(cwd)
              return null
            }
            if (deps.shouldCapture && !(await deps.shouldCapture(project))) return null
            deps.rememberProject?.(cwd, project)
            return { project, cutoff: await deps.syncFromFor?.(project) }
          })()
          eligibleByCwd.set(cwd, result)
          return result
        }
        const unread = new Set<string>()
        const historyOf = async (thread: CodexThread): Promise<CodexHistory> => {
          const prev = codexCheckpoint(store, thread.id)
          if (prev?.updatedAt === thread.updatedAt) {
            unread.add(thread.id)
            return { thread, turns: [], items: [] }
          }
          const fromTurnId = prev?.pending[0]?.turnId ?? prev?.end?.turnId
          const history = await reader.readThread(
            thread.id,
            fromTurnId ? { fromTurnId } : undefined,
          )
          const end = prev?.end
          if (!end || history.turns.some((turn) => turn.id === end.turnId)) return history
          deps.log.warn(
            { threadId: thread.id, turnId: end.turnId },
            "Codex history no longer has the saved end turn; reading it in full",
          )
          return reader.readThread(thread.id)
        }
        const batches: SessionBatch[] = []
        for (const root of roots) {
          try {
            const selection = await eligible(root.cwd)
            if (!selection) continue
            const { project, cutoff } = selection
            if (cutoff && root.createdAt * 1000 < Date.parse(cutoff)) continue
            const family: CodexHistory[] = []
            const visit = async (thread: CodexThread): Promise<void> => {
              if (family.some((member) => member.thread.id === thread.id)) return
              family.push(await historyOf(thread))
              for (const child of children.get(thread.id) ?? []) {
                try {
                  await visit(child)
                } catch (err) {
                  deps.log.warn(
                    { err, threadId: child.id },
                    "Codex child history unavailable; it will retry",
                  )
                }
              }
            }
            await visit(root)
            const reloaded = new Set<string>()
            for (const child of [...family]) {
              const parentId = child.thread.parentThreadId
              if (
                !parentId ||
                store.checkpoints[`codex:${child.thread.id}`] ||
                !store.checkpoints[`codex:${parentId}`] ||
                reloaded.has(parentId)
              )
                continue
              const index = family.findIndex((member) => member.thread.id === parentId)
              if (index < 0) continue
              try {
                family[index] = await reader.readThread(parentId)
                reloaded.add(parentId)
                unread.delete(parentId)
              } catch (err) {
                deps.log.warn({ err, threadId: parentId }, "Codex spawn history unavailable")
              }
            }
            const tracks = family.map((history) =>
              buildTrack({
                history,
                family,
                sessionId: root.id,
                project,
                store,
                read: !unread.has(history.thread.id),
                listedAt,
              }),
            )
            const active = tracks.filter((track) => changed(track, store))
            const needed = new Set([root.id])
            const parentById = new Map(
              family.map((member) => [member.thread.id, member.thread.parentThreadId]),
            )
            for (const track of active) {
              let id: string | null | undefined =
                track.type === "main" ? root.id : track.agent.agentId
              while (id && !needed.has(id)) {
                needed.add(id)
                id = parentById.get(id)
              }
            }
            if (tracks[0] && active.length > 0)
              batches.push({
                sessionId: root.id,
                tracks: tracks.filter((track) =>
                  needed.has(track.type === "main" ? root.id : track.agent.agentId),
                ),
              })
          } catch (err) {
            deps.log.warn({ err, threadId: root.id }, "Codex session could not be collected")
          }
        }
        return batches
      } catch (err) {
        deps.log.debug({ err }, "Codex capture unavailable")
        return []
      }
    },
  }
}
