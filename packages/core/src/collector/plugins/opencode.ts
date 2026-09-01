import { execFile } from "node:child_process"
import { createRequire } from "node:module"
import { homedir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { z } from "zod"
import type {
  NormalizedMessage,
  ParsedRecord,
  ProjectIdentity,
  TokenUsage,
  ToolCallMetadata,
  ToolResultMetadata,
} from "../../ingest/types.js"
import { normalizedMessageSchema } from "../../ingest/types.js"
import { compact, uuidV5 } from "../helpers.js"
import { redactJson } from "../redact.js"
import type {
  AgentPlugin,
  CheckpointBody,
  CheckpointStore,
  CollectDeps,
  SessionBatch,
  SessionTrack,
} from "../types.js"

const SOURCE = "opencode" as const
const SCHEMA_VERSION = 1
/** OpenCode ids are `msg_…`, not uuids; hashing them under a private namespace keeps them stable. */
const URL_NAMESPACE = "0191d942-3ba5-7dba-9a7d-22d65b30258c"

export interface OpencodeStatement {
  all(...params: ReadonlyArray<unknown>): ReadonlyArray<Record<string, unknown>>
}

/** The plugin only ever reads; OpenCode owns the file. */
export interface OpencodeDatabase {
  readonly dbPath: string
  prepare(sql: string): OpencodeStatement
  close(): void
}

type SqliteDatabase = {
  prepare(sql: string): OpencodeStatement
  close(): void
}

const nodeRequire = createRequire(import.meta.url)

/**
 * bun:sqlite under bun, better-sqlite3 under node (where the released CLI runs): bun cannot dlopen
 * better-sqlite3 (bun #4290). Both open read-only and refuse a missing file, so an absent OpenCode
 * install throws here rather than creating an empty database.
 */
const openReadonly = (path: string): SqliteDatabase => {
  if ("Bun" in globalThis) {
    const bun: {
      readonly Database: new (
        path: string,
        options: { readonly readonly: boolean; readonly create: boolean },
      ) => SqliteDatabase
    } = nodeRequire("bun:sqlite")
    return new bun.Database(path, { readonly: true, create: false })
  }
  const Database: new (
    path: string,
    options: { readonly readonly: boolean; readonly fileMustExist: boolean },
  ) => SqliteDatabase = nodeRequire("better-sqlite3")
  return new Database(path, { readonly: true, fileMustExist: true })
}

export const openDatabase = (dbPath: string): OpencodeDatabase => {
  const db = openReadonly(dbPath)
  return { dbPath, prepare: (sql) => db.prepare(sql), close: () => db.close() }
}

export const defaultDbPath = (home: string = homedir()): string =>
  join(home, ".local", "share", "opencode", "opencode.db")

export type Exec = (file: string, args: ReadonlyArray<string>) => Promise<string>

const execFileAsync = promisify(execFile)
const defaultExec: Exec = async (file, args) => {
  const { stdout } = await execFileAsync(file, [...args], { timeout: 5_000 })
  return stdout
}

/** Asks the OpenCode CLI where its database lives; the platform default covers a missing binary. */
export const resolveDbPath = async (
  exec: Exec = defaultExec,
  home: string = homedir(),
): Promise<string> => {
  try {
    const path = (await exec("opencode", ["db", "path"])).trim()
    if (path !== "") return path
  } catch {
    // Binary missing, subcommand unknown, or timed out -- the default is the only path shipped.
  }
  return defaultDbPath(home)
}

const optionalString = z.string().min(1).optional().catch(undefined)
const nonnegativeInt = z.number().int().nonnegative().catch(0)

const sessionRowSchema = z.object({
  id: z.string(),
  parent_id: z.string().nullable(),
  slug: z.string(),
  directory: z.string(),
  title: z.string(),
  time_created: z.number(),
  time_updated: z.number(),
  agent: z.string().nullable(),
})
const messageRowSchema = z.object({ id: z.string(), time_created: z.number(), data: z.string() })
const partRowSchema = messageRowSchema.extend({ message_id: z.string() })

/** The `data` column is OpenCode's own JSON; only the fields read here are typed, leniently. */
const messageDataSchema = z.looseObject({
  role: z.enum(["user", "assistant"]),
  path: z.looseObject({ cwd: optionalString }).optional().catch(undefined),
  tokens: z
    .looseObject({
      input: nonnegativeInt,
      output: nonnegativeInt,
      reasoning: nonnegativeInt,
      cache: z.looseObject({ read: nonnegativeInt }).optional().catch(undefined),
    })
    .optional()
    .catch(undefined),
})
const partDataSchema = z.looseObject({
  type: optionalString,
  tool: optionalString,
  callID: optionalString,
  text: z.string().optional().catch(undefined),
  reason: optionalString,
  error: optionalString,
  path: optionalString,
  filename: optionalString,
  state: z
    .looseObject({
      status: optionalString,
      input: z.record(z.string(), z.unknown()).optional().catch(undefined),
      output: z.unknown().optional(),
    })
    .optional()
    .catch(undefined),
})
type PartData = z.infer<typeof partDataSchema>
type SessionRow = z.infer<typeof sessionRowSchema>

export type OpencodeRow = {
  readonly id: string
  readonly timeCreated: number
  readonly data: Record<string, unknown>
}

export type OpencodeContext = {
  readonly sessionId: string
  readonly trackId: string
  readonly agentId?: string
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isoOf = (ms: number): string | undefined => (ms > 0 ? new Date(ms).toISOString() : undefined)

const parsedMessage = (value: unknown): NormalizedMessage => normalizedMessageSchema.parse(value)

const tokensOf = (tokens: z.infer<typeof messageDataSchema>["tokens"]): TokenUsage | undefined =>
  tokens === undefined
    ? undefined
    : {
        input: tokens.input,
        output: tokens.output,
        cached: tokens.cache?.read ?? 0,
        thinking: tokens.reasoning,
      }

const toolStatus = (
  status: string | undefined,
): "success" | "failure" | "cancelled" | "unknown" => {
  if (status === "completed") return "success"
  if (status === "error" || status === "failed") return "failure"
  if (status === "cancelled") return "cancelled"
  return "unknown"
}

const isFinished = (status: string | undefined): boolean =>
  status !== undefined && status !== "running" && status !== "pending"

type Shared = ReturnType<typeof commonFor> & { readonly subIndex: number }

/**
 * OpenCode's tool vocabulary, mapped here and nowhere else. The write tools' input field names
 * are taken from OpenCode's conventions rather than a captured session, so a real one may correct
 * them in this one place. Nothing in `state` is known to hold the file's prior content, so a
 * wrote effect never carries a `base`.
 */
const WRITE_TOOLS = new Set(["write", "edit", "patch"])
const stringOf = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined

const shellMetadataFor = (
  tool: string,
  input: Record<string, unknown> | undefined,
): ToolCallMetadata | undefined => {
  const command = tool === "bash" ? stringOf(input?.command) : undefined
  return command === undefined ? undefined : { type: "shell", command }
}

const wroteMetadataFor = (
  tool: string,
  input: Record<string, unknown> | undefined,
): ToolResultMetadata | undefined => {
  const path = WRITE_TOOLS.has(tool)
    ? (stringOf(input?.filePath) ?? stringOf(input?.file_path))
    : undefined
  return path === undefined ? undefined : { type: "wrote", path, created: tool === "write" }
}

const commonFor = (context: OpencodeContext, cwd: string | undefined, timeMs: number) => ({
  sessionId: context.sessionId,
  source: SOURCE,
  sourceSchemaVersion: SCHEMA_VERSION,
  trackId: context.trackId,
  agentId: context.agentId,
  timestamp: isoOf(timeMs),
  cwd,
})

/**
 * A tool part is one row that OpenCode mutates in place: `toolCall` while it runs, `toolCall` +
 * `toolResult` once it finishes. The result takes the odd slot reserved beside its call so a tool
 * finishing between two captures never shifts a later part's subIndex.
 */
const toolMessages = (
  part: PartData,
  partId: string,
  shared: Shared,
): ReadonlyArray<NormalizedMessage> => {
  const callId = part.callID ?? partId
  const tool = part.tool ?? "unknown"
  const input = part.state?.input
  const call = parsedMessage({
    ...shared,
    msgType: "toolCall",
    details: { callId, name: tool, input: input ?? {}, metadata: shellMetadataFor(tool, input) },
  })
  if (!isFinished(part.state?.status)) return [call]
  const status = toolStatus(part.state?.status)
  return [
    call,
    parsedMessage({
      ...shared,
      subIndex: shared.subIndex + 1,
      msgType: "toolResult",
      details: {
        callId,
        output: part.state?.output ?? null,
        status,
        // A write that did not complete wrote nothing.
        metadata: status === "success" ? wroteMetadataFor(tool, input) : undefined,
      },
    }),
  ]
}

const turnEvent = (part: PartData, shared: Shared): NormalizedMessage => {
  const aborted = part.reason === "error" || part.reason === "aborted"
  return parsedMessage({
    ...shared,
    msgType: "turnEvent",
    details: {
      type: aborted ? "aborted" : "duration",
      status: aborted ? "aborted" : "completed",
      reason: aborted ? part.error : undefined,
    },
  })
}

type PartInput = {
  readonly row: OpencodeRow
  readonly part: PartData
  readonly shared: Shared
  readonly tokens: TokenUsage | undefined
}

const partMessages = ({
  row,
  part,
  shared,
  tokens,
}: PartInput): ReadonlyArray<NormalizedMessage> => {
  const assistant = { ...shared, msgType: "message", role: "assistant" } as const
  switch (part.type) {
    case "text":
      return [
        parsedMessage({ ...assistant, content: { type: "text", value: part.text ?? "" }, tokens }),
      ]
    case "reasoning":
      return [parsedMessage({ ...assistant, content: { type: "reasoning", value: part.text } })]
    case "tool":
      return toolMessages(part, row.id, shared)
    case "file":
      return [
        parsedMessage({
          ...shared,
          msgType: "fileEvent",
          details: { type: "attached", path: part.path ?? part.filename ?? "unknown" },
        }),
      ]
    case "patch":
      return [
        parsedMessage({
          ...shared,
          msgType: "fileEvent",
          details: { type: "edited", path: part.path ?? "unknown" },
        }),
      ]
    case "step-finish":
      return [turnEvent(part, shared)]
    default:
      return [parsedMessage({ ...shared, msgType: "custom", subType: part.type ?? "unknown" })]
  }
}

/**
 * One OpenCode message is one record; its parts fan out into messages. A user message collapses to
 * its text; an assistant message emits per part, each part owning subIndexes `2i` and `2i + 1`.
 */
export const normalizeOpencode = (
  message: OpencodeRow,
  parts: ReadonlyArray<OpencodeRow>,
  context: OpencodeContext,
): ReadonlyArray<NormalizedMessage> => {
  const data = messageDataSchema.safeParse(message.data)
  if (!data.success) return []
  const common = commonFor(context, data.data.path?.cwd, message.timeCreated)
  const parsedParts = parts.map((row) => ({ row, part: partDataSchema.parse(row.data) }))

  if (data.data.role === "user") {
    const text = parsedParts.find(({ part }) => part.type === "text")?.part.text ?? ""
    return [
      parsedMessage({
        ...common,
        subIndex: 0,
        msgType: "message",
        role: "user",
        content: { type: "text", value: text },
      }),
    ]
  }

  const tokens = tokensOf(data.data.tokens)
  const firstText = parsedParts.findIndex(({ part }) => part.type === "text")
  return parsedParts.flatMap(({ row, part }, index) =>
    partMessages({
      row,
      part,
      shared: {
        ...common,
        timestamp: isoOf(row.timeCreated) ?? common.timestamp,
        subIndex: index * 2,
      },
      tokens: index === firstText ? tokens : undefined,
    }),
  )
}

/** OpenCode writes JSON into a TEXT column; a row the producer never finished is unparseable. */
const readRedactedJson = (raw: string): Record<string, unknown> => {
  try {
    const redacted = redactJson(JSON.parse(raw))
    return isObject(redacted) ? redacted : {}
  } catch {
    return {}
  }
}

const groupBy = <T>(
  items: ReadonlyArray<T>,
  keyOf: (item: T) => string,
): ReadonlyMap<string, ReadonlyArray<T>> =>
  items.reduce(
    (groups, item) => groups.set(keyOf(item), [...(groups.get(keyOf(item)) ?? []), item]),
    new Map<string, ReadonlyArray<T>>(),
  )

const checkpointKeyOf = (session: SessionRow): string => `${SOURCE}:${session.id}`

const isUpToDate = (prev: CheckpointStore, session: SessionRow): boolean => {
  const checkpoint = prev.checkpoints[checkpointKeyOf(session)]
  return checkpoint?.source === SOURCE && checkpoint.timeUpdated >= session.time_updated
}

type TrackInput = {
  readonly db: OpencodeDatabase
  readonly session: SessionRow
  readonly project: ProjectIdentity
  /** The batch's main session: a subagent's rows attach to it, never to the child's own id. */
  readonly sessionId: string
}

const buildTrack = ({ db, session, project, sessionId }: TrackInput): SessionTrack => {
  const messages = db
    .prepare(
      "SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created, id",
    )
    .all(session.id)
    .map((row) => messageRowSchema.parse(row))
  const partsByMessage = groupBy(
    db
      .prepare(
        "SELECT id, message_id, time_created, data FROM part WHERE session_id = ? ORDER BY time_created, id",
      )
      .all(session.id)
      .map((row) => partRowSchema.parse(row)),
    (part) => part.message_id,
  )
  const isSubagent = session.parent_id !== null
  const context: OpencodeContext = {
    sessionId,
    trackId: isSubagent ? `agent:${session.id}` : "main",
    ...(isSubagent ? { agentId: session.id } : {}),
  }

  // `lineNumber` is a small per-session sequence: the column is int4 and cannot hold a unix
  // millisecond timestamp, and only the order matters.
  const records = messages.flatMap((row, index): ParsedRecord[] => {
    const message = { id: row.id, timeCreated: row.time_created, data: readRedactedJson(row.data) }
    const parts = (partsByMessage.get(row.id) ?? []).map((part) => ({
      id: part.id,
      timeCreated: part.time_created,
      data: readRedactedJson(part.data),
    }))
    const [first, ...rest] = normalizeOpencode(message, parts, context)
    if (!first) return []
    return [
      {
        lineUuid: uuidV5(URL_NAMESPACE, row.id),
        lineNumber: index + 1,
        raw: { ...message.data, parts: parts.map((part) => part.data) },
        messages: [first, ...rest],
      },
    ]
  })

  // A flush that stopped before the last line must leave the session stale, so the next cycle
  // re-collects it; the full watermark is earned only by the line that closes the session.
  const checkpointAt = (lineNumber: number): CheckpointBody => ({
    source: SOURCE,
    timeUpdated: lineNumber >= messages.length ? session.time_updated : 0,
    lastMessageId: messages[lineNumber - 1]?.id ?? "",
  })
  const shared = {
    sessionId,
    source: SOURCE,
    project,
    sourceRelativePath: `${session.slug}/${session.id}`,
    records,
    checkpointKey: checkpointKeyOf(session),
    lastLineProcessed: messages.length,
    checkpointAt,
  }
  if (isSubagent) {
    return {
      ...shared,
      type: "subagent",
      agent: {
        agentId: session.id,
        ...(session.agent === null ? {} : { agentType: session.agent }),
      },
    }
  }
  return { ...shared, type: "main", ...(session.title === "" ? {} : { title: session.title }) }
}

type FamilyInput = {
  readonly db: OpencodeDatabase
  readonly main: SessionRow
  readonly children: ReadonlyArray<SessionRow>
  readonly prev: CheckpointStore
  readonly deps: CollectDeps
  readonly resolve: (dir: string) => Promise<ProjectIdentity | null>
}

/**
 * A parent and its subagent sessions ship as one batch, and each is judged by its own watermark:
 * a quiet parent must not hide a child that moved. Sessions without messages yet are left for a
 * later cycle rather than sent as an empty track.
 */
const collectFamily = async ({
  db,
  main,
  children,
  prev,
  deps,
  resolve,
}: FamilyInput): Promise<SessionBatch | null> => {
  const project = (await resolve(main.directory)) ?? prev.projects?.[main.directory]
  if (!project) return null
  if (deps.shouldCapture && !(await deps.shouldCapture(project))) return null
  const cutoff = await deps.syncFromFor?.(project)
  if (cutoff !== undefined && main.time_created < Date.parse(cutoff)) return null

  const tracks = [main, ...children]
    .filter((session) => !isUpToDate(prev, session))
    .map((session) => buildTrack({ db, session, project, sessionId: main.id }))
    .filter((track) => track.records.length > 0)
  return tracks.length === 0 ? null : { sessionId: main.id, tracks }
}

export const createOpencodePlugin = (deps: { readonly db: OpencodeDatabase }): AgentPlugin => {
  // A resolved identity is cached for the daemon's lifetime; an unresolved one stays retryable.
  const projectByDir = new Map<string, Promise<ProjectIdentity | null>>()
  const resolveWith =
    (collectDeps: CollectDeps) =>
    async (dir: string): Promise<ProjectIdentity | null> => {
      const pending = projectByDir.get(dir) ?? collectDeps.resolveProject(dir)
      projectByDir.set(dir, pending)
      const project = await pending
      if (!project) projectByDir.delete(dir)
      else collectDeps.rememberProject?.(dir, project)
      return project
    }

  return {
    source: SOURCE,
    collect: async (prev, collectDeps) => {
      const sessions = deps.db
        .prepare(
          "SELECT id, parent_id, slug, directory, title, time_created, time_updated, agent FROM session ORDER BY time_updated DESC, id",
        )
        .all()
        .map((row) => sessionRowSchema.parse(row))
      const childrenOf = groupBy(
        sessions.filter((session) => session.parent_id !== null),
        (session) => session.parent_id ?? "",
      )
      const resolve = resolveWith(collectDeps)

      const batches = await Promise.all(
        sessions
          .filter((session) => session.parent_id === null)
          .map(async (main) => {
            try {
              return await collectFamily({
                db: deps.db,
                main,
                children: childrenOf.get(main.id) ?? [],
                prev,
                deps: collectDeps,
                resolve,
              })
            } catch (error) {
              collectDeps.log.error(
                { sessionId: main.id, err: error },
                "OpenCode session skipped: unreadable rows",
              )
              return null
            }
          }),
      )
      return compact(batches)
    },
  }
}
