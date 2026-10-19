import { createHash } from "node:crypto"
import { resolve } from "node:path"
import { z } from "zod"
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
  CodexReadOptions,
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
  const toolTypes = [
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
  if (!toolTypes.includes(entry.item.type)) return [custom()]
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
  if (item.status === "inProgress" || item.status === "in_progress") return [call]
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

type ItemState = CodexCheckpoint["items"][string]
type Candidate = { readonly key: string; readonly state: ItemState; readonly record: ParsedRecord }

const buildTrack = (input: {
  readonly history: CodexHistory
  readonly family: ReadonlyArray<CodexHistory>
  readonly sessionId: string
  readonly project: ProjectIdentity
  readonly store: CheckpointStore
}): SessionTrack => {
  const { history, sessionId, project, store } = input
  const { thread } = history
  const checkpointKey = `codex:${thread.id}`
  const previous = store.checkpoints[checkpointKey]
  const prev = previous?.source === "codex" ? previous : undefined
  let nextOrdinal = prev?.nextOrdinal ?? 1
  const turnEvents: CodexItemEntry[] = history.turns
    .filter(
      (turn) =>
        turn.status !== "inProgress" &&
        !(turn.status === "interrupted" && turn.completedAt == null),
    )
    .map((turn) => ({
      turnId: turn.id,
      item: {
        id: `turn:${turn.id}`,
        type: "turnCompleted",
        status: turn.status,
        completedAt: turn.completedAt ?? null,
      },
      ...(turn.completedAt === null || turn.completedAt === undefined
        ? {}
        : { startedAtMs: turn.completedAt * 1000 }),
    }))
  const byTurn = new Map<string, CodexItemEntry[]>()
  for (const entry of history.items) {
    const items = byTurn.get(entry.turnId)
    if (items) items.push(entry)
    else byTurn.set(entry.turnId, [entry])
  }
  const turns = new Map(history.turns.map((turn) => [turn.id, turn]))
  const events = new Map(turnEvents.map((entry) => [entry.turnId, entry]))
  const entries = [
    ...history.turns.flatMap((turn) => [
      ...(byTurn.get(turn.id) ?? []),
      ...(events.has(turn.id)
        ? [events.get(turn.id)].filter((entry): entry is CodexItemEntry => entry !== undefined)
        : []),
    ]),
    ...history.items.filter((entry) => !turns.has(entry.turnId)),
  ]
  const candidates: Candidate[] = []
  const observed = new Map<string, ItemState>()
  for (const original of entries) {
    const entry = redactedEntry(original)
    const key = JSON.stringify([entry.turnId, entry.item.id])
    const known = prev?.items[key]
    const ordinal = known?.ordinal ?? nextOrdinal++
    const turn = turns.get(entry.turnId)
    const unsettled =
      !turn ||
      turn.status === "inProgress" ||
      (turn.status === "interrupted" && turn.completedAt == null)
    const mutableWithoutStatus =
      entry.item.type === "webSearch" ||
      (entry.item.type === "imageGeneration" &&
        !["completed", "failed", "declined", "interrupted"].includes(
          stringOf(entry.item.status) ?? "",
        ))
    const waiting =
      (["agentMessage", "plan", "reasoning"].includes(entry.item.type) || mutableWithoutStatus) &&
      !entry.completedAtMs &&
      unsettled
    const state = {
      ordinal,
      acknowledged: known?.acknowledged ?? [],
      pending: waiting || entry.item.status === "inProgress" || entry.item.status === "in_progress",
    }
    observed.set(key, state)
    if (waiting) continue
    const messages = normalized(entry, { history, sessionId }).filter(
      (message) => !known?.acknowledged.includes(message.subIndex),
    )
    const [first, ...rest] = messages
    if (!first) continue
    candidates.push({
      key,
      state,
      record: {
        lineUuid: uuidV5(
          NAMESPACE,
          JSON.stringify(["codex", thread.id, entry.turnId, entry.item.id]),
        ),
        lineNumber: ordinal,
        raw: redactJson(entry),
        messages: [first, ...rest],
      },
    })
  }
  candidates.sort((left, right) => left.state.ordinal - right.state.ordinal)
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
  const lastLineProcessed = nextOrdinal - 1
  const checkpointAt = (line: number): CheckpointBody => {
    const acknowledged = candidates.filter((candidate) => candidate.state.ordinal <= line)
    const items = {
      ...prev?.items,
      ...Object.fromEntries([...observed].filter(([, state]) => state.ordinal <= line)),
      ...Object.fromEntries(
        acknowledged.map((candidate) => [
          candidate.key,
          {
            ...candidate.state,
            acknowledged: [
              ...new Set([
                ...candidate.state.acknowledged,
                ...candidate.record.messages.map((message) => message.subIndex),
              ]),
            ],
          },
        ]),
      ),
    }
    return {
      source: "codex",
      threadId: thread.id,
      sessionId,
      metadataHash:
        acknowledged.length === candidates.length ? metadataHash : (prev?.metadataHash ?? ""),
      ...(spawnToolUseId ? { spawnToolUseId } : {}),
      items,
      nextOrdinal: Object.values(items).reduce((max, item) => Math.max(max, item.ordinal + 1), 1),
    }
  }
  const shared = {
    sessionId,
    source: "codex" as const,
    project,
    sourceRelativePath: `codex/${thread.id}`,
    records: candidates.map((candidate) => candidate.record),
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

const changed = (track: SessionTrack, store: CheckpointStore): boolean => {
  const prev = store.checkpoints[track.checkpointKey]
  const next = track.checkpointAt(track.lastLineProcessed)
  return (
    track.records.length > 0 ||
    prev?.source !== "codex" ||
    (next.source === "codex" && prev.metadataHash !== next.metadataHash)
  )
}

const readOptionsFor = (
  previous: CheckpointStore["checkpoints"][string] | undefined,
): CodexReadOptions | undefined => {
  if (previous?.source !== "codex") return undefined
  const settledTurns = new Set<string>()
  const pendingTurns = new Set<string>()
  for (const [key, state] of Object.entries(previous.items)) {
    const [turnId, itemId] = z.tuple([z.string(), z.string()]).parse(JSON.parse(key))
    if (state.pending) pendingTurns.add(turnId)
    if (itemId === `turn:${turnId}` && state.acknowledged.includes(0)) settledTurns.add(turnId)
  }
  return { settledTurns, pendingTurns }
}

export const createCodexPlugin = ({
  reader,
}: {
  readonly reader: CodexHistoryReader
}): AgentPlugin => {
  const projectsByCwd = new Map<string, Promise<ProjectIdentity | null>>()
  return {
    source: "codex",
    close: () => reader.close(),
    collect: async (store, deps): Promise<ReadonlyArray<SessionBatch>> => {
      try {
        const threads = await reader.listThreads()
        const children = new Map<string, string[]>()
        for (const thread of threads)
          if (thread.parentThreadId) {
            const siblings = children.get(thread.parentThreadId)
            if (siblings) siblings.push(thread.id)
            else children.set(thread.parentThreadId, [thread.id])
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
        const batches: SessionBatch[] = []
        for (const root of roots) {
          try {
            const selection = await eligible(root.cwd)
            if (!selection) continue
            const { project, cutoff } = selection
            if (cutoff && root.createdAt * 1000 < Date.parse(cutoff)) continue
            const family: CodexHistory[] = []
            const visit = async (id: string): Promise<void> => {
              if (family.some((member) => member.thread.id === id)) return
              family.push(
                await reader.readThread(id, readOptionsFor(store.checkpoints[`codex:${id}`])),
              )
              for (const child of children.get(id) ?? []) {
                try {
                  await visit(child)
                } catch (err) {
                  deps.log.warn(
                    { err, threadId: child },
                    "Codex child history unavailable; it will retry",
                  )
                }
              }
            }
            await visit(root.id)
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
              } catch (err) {
                deps.log.warn({ err, threadId: parentId }, "Codex spawn history unavailable")
              }
            }
            const tracks = family.map((history) =>
              buildTrack({ history, family, sessionId: root.id, project, store }),
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
