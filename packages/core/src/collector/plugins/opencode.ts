import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { homedir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import type {
  AgentInfo,
  NormalizedContent,
  NormalizedMessage,
  ParsedRecord,
  ProjectIdentity,
} from "../../ingest/types.js"
import { normalizedMessageSchema, type SessionSource } from "../../ingest/types.js"
import type {
  AgentPlugin,
  CheckpointStore,
  CollectDeps,
  SessionBatch,
  SessionTrack,
} from "../types.js"

/**
 * SQLite driver shim: bun:sqlite when running under bun (dev), better-sqlite3 when running
 * under Node 22+ (released CLI). Both expose `prepare(sql)` returning an object with
 * `.all(...)` and `.get(...)`; we hide the differences behind a tiny adapter so the plugin
 * only ever sees `OpencodeDatabase`. better-sqlite3 is a runtime dep of @samskara/core so
 * the production tarball ships with native binaries; bun:sqlite is built into bun and needs
 * no extra module.
 *
 * Bun cannot yet dlopen better-sqlite3 (bun #4290), which is why the dev path does not use
 * it -- and node:sqlite would need a Node-22-only experimental flag we do not want to
 * require from operators.
 */
type SqliteStatement = {
  readonly all: (...params: ReadonlyArray<unknown>) => ReadonlyArray<Record<string, unknown>>
  readonly get: (...params: ReadonlyArray<unknown>) => Record<string, unknown> | undefined
}
type SqliteDatabaseLike = {
  prepare(sql: string): SqliteStatement
  close(): void
}

const loadDriver = (): {
  readonly open: (path: string, readonly: boolean) => SqliteDatabaseLike
} => {
  const bun = (globalThis as { readonly Bun?: unknown }).Bun
  if (bun !== undefined) {
    type BunDatabase = {
      prepare(sql: string): {
        all(...params: ReadonlyArray<unknown>): ReadonlyArray<Record<string, unknown>>
        get(...params: ReadonlyArray<unknown>): Record<string, unknown> | undefined
      }
      close(): void
    }
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("bun:sqlite") as { Database: new (path: string) => BunDatabase }
    return {
      open: (path) => {
        const db = new mod.Database(path)
        return {
          prepare: (sql) => {
            const stmt = db.prepare(sql)
            return {
              all: (...params) => stmt.all(...params),
              get: (...params) => stmt.get(...params),
            }
          },
          close: () => db.close(),
        }
      },
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require("better-sqlite3") as new (
    path: string,
    options: { readonly: boolean; fileMustExist: boolean },
  ) => {
    prepare(sql: string): {
      all(...params: ReadonlyArray<unknown>): ReadonlyArray<Record<string, unknown>>
      get(...params: ReadonlyArray<unknown>): Record<string, unknown> | undefined
    }
    close(): void
  }
  return {
    open: (path, readonly) => {
      const db = new Database(path, { readonly, fileMustExist: true })
      return {
        prepare: (sql) => {
          const stmt = db.prepare(sql)
          return {
            all: (...params) => stmt.all(...params),
            get: (...params) => stmt.get(...params),
          }
        },
        close: () => db.close(),
      }
    },
  }
}

const execFileAsync = promisify(execFile)

/**
 * Opencode message ids look like `msg_03a606e89001LnMfUOBx9fYl9T` -- not UUIDs, and the ingest
 * schema requires UUID lineUuid. Hash the opencode id with the same uuidv5 trick the claude
 * plugin uses so every capture sees a stable, collision-resistant id.
 */
const OPENCODE_URL_NAMESPACE = "0191d942-3ba5-7dba-9a7d-22d65b30258c"
const uuidBytes = (uuid: string): Buffer => Buffer.from(uuid.replaceAll("-", ""), "hex")
const formatUuid = (bytes: Buffer): string => {
  const hex = bytes.toString("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
const lineUuidFor = (id: string): string => {
  const digest = createHash("sha1")
    .update(Buffer.concat([uuidBytes(OPENCODE_URL_NAMESPACE), Buffer.from(id, "utf8")]))
    .digest()
    .subarray(0, 16)
  const bytes = Buffer.from(digest)
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80
  return formatUuid(bytes)
}

export const SOURCE = "opencode" as const satisfies SessionSource

/**
 * The minimum surface the plugin reads from the opencode database. Tests inject a wrapper
 * around better-sqlite3; production wires `openDatabase` over a real read-only handle. Any
 * other query (writes, schema migrations) stays out — opencode owns the file, we only read.
 */
export interface OpencodeStatement {
  all(...params: ReadonlyArray<unknown>): ReadonlyArray<Record<string, unknown>>
  get(...params: ReadonlyArray<unknown>): Record<string, unknown> | undefined
}

export interface OpencodeDatabase {
  readonly dbPath: string
  prepare(sql: string): OpencodeStatement
  close(): void
}

type RawPart = {
  readonly id: string
  readonly time_created: number
  readonly type?: string
  readonly tool?: string
  readonly callID?: string
  readonly text?: string
  readonly reason?: string
  readonly state?: {
    readonly status?: string
    readonly input?: Record<string, unknown>
    readonly output?: unknown
  }
  readonly [key: string]: unknown
}

type RawMessage = {
  readonly id: string
  readonly time_created: number
  readonly role: "user" | "assistant"
  readonly path?: { readonly cwd?: string; readonly root?: string }
  readonly tokens?: {
    readonly total?: number
    readonly input?: number
    readonly output?: number
    readonly reasoning?: number
    readonly cache?: { readonly read?: number; readonly write?: number }
  }
}

export type NormalizeContext = {
  readonly sessionId: string
  readonly trackId: string
  readonly lineNumber: number
  /** Subagent-only: the opencode agent type ("build" / "explore" / "plan" / "general"). */
  readonly agentType?: string
  /** Subagent-only: a stable id within the parent session. */
  readonly agentId?: string
}

const isString = (value: unknown): value is string => typeof value === "string" && value.length > 0

const nonnegative = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0

const tokenUsageOf = (
  tokens: RawMessage["tokens"],
):
  | {
      input: number
      output: number
      cached: number
      thinking: number
    }
  | undefined => {
  if (!tokens) return undefined
  return {
    input: nonnegative(tokens.input),
    output: nonnegative(tokens.output),
    cached: nonnegative(tokens.cache?.read),
    thinking: nonnegative(tokens.reasoning),
  }
}

const contentFromText = (text: string): NormalizedContent => ({ type: "text", value: text })

const contentFromReasoning = (text: string | undefined): NormalizedContent => ({
  type: "reasoning",
  ...(text === undefined ? {} : { value: text }),
})

const toolStatusFromOpencode = (
  status: string | undefined,
): "success" | "failure" | "cancelled" | "unknown" => {
  if (status === "completed") return "success"
  if (status === "error" || status === "failed") return "failure"
  if (status === "cancelled") return "cancelled"
  return "unknown"
}

const turnStatusFromReason = (reason: string | undefined): "completed" | "aborted" | "unknown" => {
  if (reason === undefined) return "completed"
  if (reason === "error" || reason === "aborted") return "aborted"
  return "completed"
}

/**
 * The shape every opencode message takes in our pipeline: a session message becomes one
 * `ParsedRecord`; its parts fan out into one or more `NormalizedMessage` entries. User
 * messages collapse to one text message; assistant messages fan out by part kind. A bash
 * tool yields both a `toolCall` and a `toolResult` from the same part, the same shape
 * `gitEvents.ts` already understands, so commit/PR extraction can stay source-agnostic.
 */
export const normalizeOpencode = (
  message: RawMessage,
  parts: ReadonlyArray<RawPart>,
  context: NormalizeContext,
): ReadonlyArray<NormalizedMessage> => {
  const out: NormalizedMessage[] = []
  const cwd = message.path?.cwd
  const usage = tokenUsageOf(message.tokens)

  if (message.role === "user") {
    const textPart = parts.find((p) => p.type === "text")
    const textValue = isString(textPart?.text) ? textPart.text : ""
    out.push({
      subIndex: 0,
      sessionId: context.sessionId,
      source: SOURCE,
      sourceSchemaVersion: 1,
      trackId: context.trackId,
      ...(context.agentId !== undefined ? { agentId: context.agentId } : {}),
      ...(message.time_created > 0
        ? { timestamp: new Date(message.time_created).toISOString() }
        : {}),
      msgType: "message",
      role: "user",
      content: contentFromText(textValue),
      ...(cwd !== undefined ? { cwd } : {}),
    })
    return out
  }

  for (const part of parts) {
    const partTs = part.time_created > 0 ? new Date(part.time_created).toISOString() : undefined
    const common = {
      sessionId: context.sessionId,
      source: SOURCE,
      sourceSchemaVersion: 1,
      trackId: context.trackId,
      ...(context.agentId !== undefined ? { agentId: context.agentId } : {}),
      ...(partTs !== undefined ? { timestamp: partTs } : {}),
      ...(cwd !== undefined ? { cwd } : {}),
    } as const

    // Each emission picks the next subIndex; two messages emitted from the same part
    // (toolCall + toolResult) get distinct indices so the (lineUuid, subIndex) unique
    // constraint never fires inside one record.
    switch (part.type) {
      case "text":
        out.push({
          ...common,
          subIndex: out.length,
          msgType: "message",
          role: "assistant",
          content: contentFromText(isString(part.text) ? part.text : ""),
          ...(usage ? { tokens: usage } : {}),
        } as NormalizedMessage)
        continue
      case "reasoning":
        out.push({
          ...common,
          subIndex: out.length,
          msgType: "message",
          role: "assistant",
          content: contentFromReasoning(isString(part.text) ? part.text : undefined),
        } as NormalizedMessage)
        continue
      case "tool": {
        const callId = isString(part.callID) ? part.callID : part.id
        const toolName = isString(part.tool) ? part.tool : "unknown"
        out.push({
          ...common,
          subIndex: out.length,
          msgType: "toolCall",
          details: {
            callId,
            name: toolName,
            input: part.state?.input ?? {},
          },
        } as NormalizedMessage)
        if (
          part.state?.status !== undefined &&
          part.state.status !== "running" &&
          part.state.status !== "pending"
        ) {
          out.push({
            ...common,
            subIndex: out.length,
            msgType: "toolResult",
            details: {
              callId,
              output: part.state.output ?? null,
              status: toolStatusFromOpencode(part.state.status),
            },
          } as NormalizedMessage)
        }
        continue
      }
      case "file": {
        const filePart = part as Record<string, unknown>
        const filePath = isString(filePart.path)
          ? (filePart.path as string)
          : isString(filePart.filename)
            ? (filePart.filename as string)
            : "unknown"
        out.push({
          ...common,
          subIndex: out.length,
          msgType: "fileEvent",
          details: {
            type: "attached",
            path: filePath,
          },
        } as NormalizedMessage)
        continue
      }
      case "patch": {
        const patchPart = part as Record<string, unknown>
        const patchPath = isString(patchPart.path) ? (patchPart.path as string) : "unknown"
        out.push({
          ...common,
          subIndex: out.length,
          msgType: "fileEvent",
          details: {
            type: "edited",
            path: patchPath,
          },
        } as NormalizedMessage)
        continue
      }
      case "step-finish": {
        const reason = isString(part.reason) ? part.reason : undefined
        const turnType: "duration" | "aborted" | "unknown" =
          reason === "error" || reason === "aborted" ? "aborted" : "duration"
        const errorField = (part as Record<string, unknown>).error
        out.push({
          ...common,
          subIndex: out.length,
          msgType: "turnEvent",
          details: {
            type: turnType,
            status: turnStatusFromReason(reason),
            ...(turnType === "aborted" && isString(errorField)
              ? { reason: errorField as string }
              : {}),
          },
        } as NormalizedMessage)
        continue
      }
      default:
        out.push({
          ...common,
          subIndex: out.length,
          msgType: "custom",
          subType: isString(part.type) ? part.type : "unknown",
        } as NormalizedMessage)
        continue
    }
  }

  return out
}

const safeParseMessages = (
  messages: ReadonlyArray<NormalizedMessage>,
): [NormalizedMessage, ...NormalizedMessage[]] | null => {
  const out: NormalizedMessage[] = []
  for (const message of messages) {
    const parsed = normalizedMessageSchema.safeParse(message)
    if (parsed.success) out.push(parsed.data)
  }
  const first = out[0]
  if (first === undefined) return null
  return [first, ...out.slice(1)]
}

type OpencodeSessionRow = {
  readonly id: string
  readonly parent_id: string | null
  readonly slug: string
  readonly directory: string
  readonly title: string
  readonly time_created: number
  readonly time_updated: number
  readonly agent: string | null
  readonly model: string | null
}

type OpencodeMessageRow = {
  readonly id: string
  readonly session_id: string
  readonly time_created: number
  readonly data: string
}

type OpencodePartRow = {
  readonly id: string
  readonly message_id: string
  readonly session_id: string
  readonly time_created: number
  readonly data: string
}

const parseRow = <T>(row: Record<string, unknown>): T => row as unknown as T

const asSessionRow = (row: Record<string, unknown>): OpencodeSessionRow =>
  parseRow<OpencodeSessionRow>(row)

const asMessageRow = (row: Record<string, unknown>): OpencodeMessageRow =>
  parseRow<OpencodeMessageRow>(row)

const asPartRow = (row: Record<string, unknown>): OpencodePartRow => parseRow<OpencodePartRow>(row)

const readJson = (raw: string, fallback: Record<string, unknown> = {}): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(raw)
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // opencode writes jsonb into TEXT; a row the producer never finished is unparseable.
  }
  return fallback
}

const agentInfoFor = (session: OpencodeSessionRow): AgentInfo => ({
  agentId: session.id,
  agentType: session.agent ?? undefined,
})

const trackIdOf = (session: OpencodeSessionRow): string =>
  session.parent_id === null ? "main" : `agent:${session.id}`

const checkpointKeyOf = (session: OpencodeSessionRow): string => `${SOURCE}:${session.id}`

const checkpointBodyFor = (
  session: OpencodeSessionRow,
  lastMessageId: string,
): {
  readonly source: "opencode"
  readonly timeUpdated: number
  readonly lastMessageId: string
} => ({
  source: SOURCE,
  timeUpdated: session.time_updated,
  lastMessageId,
})

const checkpointAtFor =
  (
    session: OpencodeSessionRow,
    lastMessageId: string,
  ): ((lineNumber: number) => {
    readonly source: "opencode"
    readonly timeUpdated: number
    readonly lastMessageId: string
  }) =>
  () =>
    checkpointBodyFor(session, lastMessageId)

const collectMessagesForSession = (
  db: OpencodeDatabase,
  sessionId: string,
): {
  messages: ReadonlyArray<OpencodeMessageRow>
  partsByMessage: Map<string, ReadonlyArray<OpencodePartRow>>
  lastMessageId: string | null
} => {
  const messageRows = db
    .prepare(
      "SELECT id, session_id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created, id",
    )
    .all(sessionId) as ReadonlyArray<Record<string, unknown>>
  const messages: OpencodeMessageRow[] = messageRows.map(asMessageRow)

  const partsByMessage = new Map<string, OpencodePartRow[]>()
  if (messages.length === 0) return { messages, partsByMessage, lastMessageId: null }

  const partRows = db
    .prepare(
      "SELECT id, message_id, session_id, time_created, data FROM part WHERE session_id = ? ORDER BY time_created, id",
    )
    .all(sessionId) as ReadonlyArray<Record<string, unknown>>
  for (const row of partRows.map(asPartRow)) {
    const bucket = partsByMessage.get(row.message_id)
    if (bucket) {
      bucket.push(row)
    } else {
      partsByMessage.set(row.message_id, [row])
    }
  }

  const lastMessage = messages[messages.length - 1]
  return { messages, partsByMessage, lastMessageId: lastMessage?.id ?? null }
}

const buildTrack = (
  session: OpencodeSessionRow,
  project: ProjectIdentity,
  messages: ReadonlyArray<OpencodeMessageRow>,
  partsByMessage: ReadonlyMap<string, ReadonlyArray<OpencodePartRow>>,
): SessionTrack => {
  const records: ParsedRecord[] = []
  const isSubagent = session.parent_id !== null
  const trackId = trackIdOf(session)
  const agentId = isSubagent ? session.id : undefined

  // The `messages.lineNumber` column is int4, so it cannot hold unix milliseconds in the
  // trillions. We assign a per-session 1-based sequence after sorting by time_created so the
  // value stays small AND ordering is preserved.
  const sortedMessages = [...messages].sort((a, b) =>
    a.time_created === b.time_created ? a.id.localeCompare(b.id) : a.time_created - b.time_created,
  )

  let lineCounter = 1
  for (const message of sortedMessages) {
    const data = readJson(message.data)
    const role = data.role
    if (role !== "user" && role !== "assistant") continue
    const path = data.path
    const pathRecord =
      typeof path === "object" && path !== null && !Array.isArray(path)
        ? (path as Record<string, unknown>)
        : undefined
    const cwd = typeof pathRecord?.cwd === "string" ? pathRecord.cwd : undefined
    const tokens = data.tokens as RawMessage["tokens"] | undefined
    const rawMessage: RawMessage = {
      id: message.id,
      time_created: message.time_created,
      role,
      ...(cwd !== undefined ? { path: { cwd } } : {}),
      ...(tokens !== undefined ? { tokens } : {}),
    }
    const partRows = (partsByMessage.get(message.id) ?? []).map((row) => {
      const d = readJson(row.data)
      return { id: row.id, time_created: row.time_created, ...d } as RawPart
    })
    const lineNumber = lineCounter++
    const normalized = normalizeOpencode(rawMessage, partRows, {
      sessionId: session.id,
      trackId,
      lineNumber,
      ...(agentId !== undefined ? { agentId } : {}),
      ...(session.agent !== null ? { agentType: session.agent } : {}),
    })
    const messages = safeParseMessages(normalized)
    if (messages === null) continue
    records.push({
      lineUuid: lineUuidFor(message.id),
      lineNumber,
      raw: data,
      messages,
    })
  }

  const lastRecord = records[records.length - 1]
  const lastMessageId = lastRecord?.lineUuid ?? ""
  const shared = {
    sessionId: session.id,
    source: SOURCE,
    project,
    sourceRelativePath: `${session.slug}/${session.id}.jsonl`,
    records,
    checkpointKey: checkpointKeyOf(session),
    lastLineProcessed: lastRecord?.lineNumber ?? session.time_created,
    checkpointAt: checkpointAtFor(session, lastMessageId),
  } as const

  if (isSubagent) {
    return { ...shared, type: "subagent", agent: agentInfoFor(session) } as SessionTrack
  }
  return { ...shared, type: "main", title: session.title } as SessionTrack
}

const isCheckpointUpToDate = (prev: CheckpointStore, session: OpencodeSessionRow): boolean => {
  const key = checkpointKeyOf(session)
  const existing = prev.checkpoints[key]
  if (existing === undefined) return false
  // Cross-source checkpoints at the same key string (e.g. a claude file path that collides)
  // are not valid opencode watermarks -- fall back to "not up to date" so the opencode
  // session is always re-emitted on first capture after the wire shape changes.
  if (existing.source !== SOURCE) return false
  return existing.timeUpdated >= session.time_updated
}

/**
 * Open the well-known opencode database read-only. WAL files (opencode.db-wal) are read by
 * better-sqlite3 in immutable mode without locking; the writer (opencode itself) keeps its
 * own handle. We never call write paths so a concurrent opencode session cannot be disturbed.
 */
export const openDatabase = async (dbPath: string): Promise<OpencodeDatabase> => {
  const driver = loadDriver()
  const db = driver.open(dbPath, true)
  return {
    dbPath,
    prepare: (sql: string): OpencodeStatement => ({
      all: (...params) => db.prepare(sql).all(...params),
      get: (...params) => db.prepare(sql).get(...params),
    }),
    close: () => db.close(),
  }
}

export const defaultDbPath = (home: string = homedir()): string =>
  join(home, ".local", "share", "opencode", "opencode.db")

export type Exec = (file: string, args: ReadonlyArray<string>) => Promise<string>

const defaultExec: Exec = async (file, args) => {
  const { stdout } = await execFileAsync(file, [...args], { timeout: 5_000 })
  return stdout
}

/**
 * Asks the opencode CLI where its database lives once; falls back to the platform default
 * when the binary is absent, the subcommand is unknown, or the call times out. The watcher
 * calls this once at startup, never per cycle.
 */
export const resolveDbPath = async (
  exec: Exec = defaultExec,
  home: string = homedir(),
): Promise<string> => {
  try {
    const out = await exec("opencode", ["db", "path"])
    const trimmed = out.trim()
    if (trimmed !== "") return trimmed
  } catch {
    // opencode binary missing, subcommand not supported, or timeout -- the default still
    // covers the only path opencode ships today.
  }
  return defaultDbPath(home)
}

export const createOpencodePlugin = (deps: { readonly db: OpencodeDatabase }): AgentPlugin => {
  const sessionsStmt = deps.db.prepare(
    "SELECT id, parent_id, slug, directory, title, time_created, time_updated, agent, model FROM session ORDER BY time_updated DESC, id",
  )

  return {
    source: SOURCE,
    collect: async (
      prev: CheckpointStore,
      collectDeps: CollectDeps,
    ): Promise<ReadonlyArray<SessionBatch>> => {
      const sessionRows = sessionsStmt.all() as ReadonlyArray<Record<string, unknown>>
      const sessions: OpencodeSessionRow[] = sessionRows.map(asSessionRow)

      const mains: OpencodeSessionRow[] = []
      const subByParent = new Map<string, OpencodeSessionRow[]>()
      for (const session of sessions) {
        if (session.parent_id === null) {
          mains.push(session)
        } else {
          const bucket = subByParent.get(session.parent_id)
          if (bucket) bucket.push(session)
          else subByParent.set(session.parent_id, [session])
        }
      }

      const batches: SessionBatch[] = []
      for (const main of mains) {
        const project = await collectDeps.resolveProject(main.directory)
        if (!project) continue
        if (collectDeps.shouldCapture && !(await collectDeps.shouldCapture(project))) {
          continue
        }
        const cutoff = await collectDeps.syncFromFor?.(project)
        if (cutoff !== undefined) {
          const cutoffMs = Date.parse(cutoff)
          if (Number.isFinite(cutoffMs) && main.time_created < cutoffMs) continue
        }
        // Children are checked before the parent's watermark decides anything: a quiet
        // parent must not hide subagent sessions that moved. The family is skipped whole
        // only when the parent AND every child are up to date.
        const staleSubs = (subByParent.get(main.id) ?? []).filter(
          (sub) => !isCheckpointUpToDate(prev, sub),
        )
        const mainUpToDate = isCheckpointUpToDate(prev, main)
        if (mainUpToDate && staleSubs.length === 0) continue

        const subTracks: SessionTrack[] = []
        for (const sub of staleSubs) {
          const subData = collectMessagesForSession(deps.db, sub.id)
          const subTrack = buildTrack(sub, project, subData.messages, subData.partsByMessage)
          subTracks.push(subTrack)
        }

        if (mainUpToDate) {
          // The parent already shipped through its watermark, so its rows are not
          // re-collected and its checkpoint is left untouched; only the moved children
          // ride this batch so their own checkpoints can advance.
          if (subTracks.length === 0) continue
          batches.push({ sessionId: main.id, tracks: subTracks })
          continue
        }

        const mainData = collectMessagesForSession(deps.db, main.id)
        const mainTrack = buildTrack(main, project, mainData.messages, mainData.partsByMessage)

        if (mainTrack.records.length === 0 && subTracks.length === 0) continue
        batches.push({ sessionId: main.id, tracks: [mainTrack, ...subTracks] })
      }
      return batches
    },
  }
}
