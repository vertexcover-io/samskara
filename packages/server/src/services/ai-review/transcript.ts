import { open, readdir } from "node:fs/promises"
import { join } from "node:path"
import { openDatabase } from "@samskara/core"

/**
 * The reviewer's own session, reconstructed from what Claude Code wrote to disk. A headless
 * `claude -p` run keeps a full transcript — one JSON record per line, user prompts,
 * assistant text, tool calls with their inputs — under
 * `$CLAUDE_CONFIG_DIR/projects/<slugified-cwd>/<session>.jsonl`. The runner redirects
 * CLAUDE_CONFIG_DIR into the workspace, so the pipeline can lift the transcript out before
 * the workspace is deleted and persist it beside the review: the reviewer's session becomes
 * evidence you can read, the same way the reviewed session is.
 */

/** The persisted transcript is capped so a runaway review cannot balloon the review row. */
export const MAX_TRANSCRIPT_ENTRIES = 400
export const MAX_TRANSCRIPT_TEXT_CHARS = 2_000

/**
 * Read limits. The transcript files and the sqlite database live inside the workspace, which
 * is the agent under review's own cwd (and its bind mount in the msb lane) — so their size is
 * agent-controlled. `MAX_TRANSCRIPT_ENTRIES` only bounds what survives the loop; these bound
 * what is loaded in the first place. The transcript is evidence beside the review, never the
 * review itself, so truncating it is always preferable to stalling the server.
 */
export const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024
export const MAX_TRANSCRIPT_ROWS = 20_000
export const MAX_TOOLS_PER_ENTRY = 50

export type ReviewerTranscriptEntry = {
  /** ISO timestamp when available, else omitted — ordering is the array order. */
  readonly at?: string
  readonly role: "user" | "assistant"
  /** The text content, when the entry has any. */
  readonly text?: string
  /** Tool invocations, when the entry made any. */
  readonly tools?: ReadonlyArray<{
    readonly name: string
    /** One-line summary of the input (the command, the path, the query…). */
    readonly input: string
  }>
}

type ClaudeJsonlRecord = {
  readonly type?: unknown
  readonly timestamp?: unknown
  readonly message?: {
    readonly role?: unknown
    readonly content?: unknown
  }
}

type ContentPart = {
  readonly type?: unknown
  readonly text?: unknown
  readonly name?: unknown
  readonly input?: unknown
}

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value : undefined

const summarizeInput = (input: unknown): string => {
  if (input === null || typeof input !== "object") return ""
  const record = input as Record<string, unknown>
  const first =
    record.command ??
    record.file_path ??
    record.path ??
    record.query ??
    record.pattern ??
    record.prompt ??
    record.description ??
    Object.values(record)[0]
  const text = typeof first === "string" ? first : JSON.stringify(first ?? "")
  return text.replace(/\s+/g, " ").slice(0, 200)
}

const entryFromRecord = (record: ClaudeJsonlRecord): ReviewerTranscriptEntry | null => {
  const role = record.type === "user" ? "user" : record.type === "assistant" ? "assistant" : null
  if (role === null) return null
  const content = record.message?.content
  const parts: ReadonlyArray<ContentPart> = Array.isArray(content)
    ? (content as ReadonlyArray<ContentPart>)
    : typeof content === "string"
      ? [{ type: "text", text: content }]
      : []
  const texts = parts
    .filter((part) => part.type === "text")
    .map((part) => asString(part.text))
    .filter((text): text is string => text !== undefined)
  const tools = parts
    .filter((part) => part.type === "tool_use")
    .map((part) => ({ name: asString(part.name) ?? "tool", input: summarizeInput(part.input) }))
    .filter((tool) => tool.input !== "")
  const text = texts.join("\n").trim()
  if (text === "" && tools.length === 0) return null
  return {
    ...(asString(record.timestamp) === undefined ? {} : { at: asString(record.timestamp) }),
    role,
    ...(text === "" ? {} : { text: text.slice(0, MAX_TRANSCRIPT_TEXT_CHARS) }),
    ...(tools.length === 0 ? {} : { tools }),
  }
}

/** The newest transcript file in the config dir's projects tree, by name sort fallback mtime. */
const newestTranscriptFile = async (configDir: string): Promise<string | null> => {
  let projects: string[]
  try {
    projects = await readdir(join(configDir, "projects"))
  } catch {
    return null
  }
  for (const project of projects) {
    const dir = join(configDir, "projects", project)
    let files: string[]
    try {
      files = (await readdir(dir)).filter((file) => file.endsWith(".jsonl"))
    } catch {
      continue
    }
    if (files.length === 0) continue
    // One headless run per workspace, so the single transcript is the one; take the last.
    return join(dir, files.sort().at(-1) ?? "")
  }
  return null
}

/**
 * The reviewer transcript from a Claude Code config dir, or null when none is there (first
 * run without auth, a crashed harness, or a non-claude lane). Never throws: a missing or
 * malformed transcript degrades to no transcript, never a failed review.
 */
export const transcriptFromClaudeConfigDir = async (
  configDir: string,
): Promise<ReadonlyArray<ReviewerTranscriptEntry> | null> => {
  const file = await newestTranscriptFile(configDir)
  if (file === null) return null
  let contents: string
  try {
    const handle = await open(file, "r")
    try {
      const buffer = Buffer.alloc(MAX_TRANSCRIPT_BYTES)
      const { bytesRead } = await handle.read(buffer, 0, MAX_TRANSCRIPT_BYTES, 0)
      contents = buffer.subarray(0, bytesRead).toString("utf8")
    } finally {
      await handle.close()
    }
  } catch {
    return null
  }
  const entries: ReviewerTranscriptEntry[] = []
  for (const line of contents.split("\n")) {
    if (entries.length >= MAX_TRANSCRIPT_ENTRIES) break
    const trimmed = line.trim()
    if (trimmed === "") continue
    let record: ClaudeJsonlRecord
    try {
      record = JSON.parse(trimmed) as ClaudeJsonlRecord
    } catch {
      continue
    }
    const entry = entryFromRecord(record)
    if (entry !== null) entries.push(entry)
  }
  return entries.length === 0 ? null : entries
}

// ─── opencode lane ──────────────────────────────────────────────────────────────────────────
//
// An opencode reviewer keeps its own session in the sqlite database under its redirected
// XDG data dir (`xdg-data/opencode/opencode.db`) — the same database layout the capture
// collector reads. For the msb lane the guest's XDG points into the bind-mounted workspace,
// so the host sees the identical file after the run.

type OpencodeRow = Record<string, unknown>

const opencodeAsString = (value: unknown): string => (typeof value === "string" ? value : "")

const opencodeJson = (raw: unknown): Record<string, unknown> => {
  if (typeof raw !== "string") return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

/**
 * The reviewer transcript from an opencode data dir (the newest session wins), or null when
 * the database is absent or empty. Never throws: a missing transcript degrades to nothing,
 * never a failed review.
 */
export const transcriptFromOpencodeDataDir = async (
  dataDir: string,
): Promise<ReadonlyArray<ReviewerTranscriptEntry> | null> => {
  const dbPath = join(dataDir, "opencode", "opencode.db")
  let db: Awaited<ReturnType<typeof openDatabase>>
  try {
    db = await openDatabase(dbPath)
  } catch {
    return null
  }
  try {
    const sessions = db
      .prepare("SELECT id FROM session ORDER BY time_updated DESC, id")
      .all() as ReadonlyArray<OpencodeRow>
    const newest = sessions[0]
    if (newest === undefined) return null
    const sessionId = String(newest.id)
    const messages = db
      .prepare(
        `SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created, id LIMIT ${MAX_TRANSCRIPT_ROWS}`,
      )
      .all(sessionId) as ReadonlyArray<OpencodeRow>
    const parts = db
      .prepare(
        `SELECT message_id, time_created, data FROM part WHERE session_id = ? ORDER BY time_created, id LIMIT ${MAX_TRANSCRIPT_ROWS}`,
      )
      .all(sessionId) as ReadonlyArray<OpencodeRow>

    // Appended, not re-spread: `[...bucket, x]` copied the whole bucket per part, so one
    // message with N parts cost N^2/2 element copies — and N is agent-controlled.
    const partsByMessage = new Map<string, Array<Record<string, unknown>>>()
    for (const part of parts) {
      const key = String(part.message_id)
      const bucket = partsByMessage.get(key)
      if (bucket === undefined) partsByMessage.set(key, [opencodeJson(part.data)])
      else bucket.push(opencodeJson(part.data))
    }

    const entries: ReviewerTranscriptEntry[] = []
    for (const message of messages) {
      if (entries.length >= MAX_TRANSCRIPT_ENTRIES) break
      const data = opencodeJson(message.data)
      const role = data.role === "user" ? "user" : data.role === "assistant" ? "assistant" : null
      if (role === null) continue
      const messageParts = partsByMessage.get(String(message.id)) ?? []
      const texts = messageParts
        .filter((part) => part.type === "text")
        .map((part) => opencodeAsString(part.text))
        .filter((text) => text !== "")
      const tools = messageParts
        .filter((part) => part.type === "tool")
        .map((part) => {
          const state = (part.state ?? {}) as Record<string, unknown>
          return {
            name: opencodeAsString(part.tool) === "" ? "tool" : opencodeAsString(part.tool),
            input: summarizeInput(state.input),
          }
        })
        .filter((tool) => tool.input !== "")
      const text = texts.join("\n").trim()
      if (text === "" && tools.length === 0) continue
      entries.push({
        role,
        ...(text === "" ? {} : { text: text.slice(0, MAX_TRANSCRIPT_TEXT_CHARS) }),
        ...(tools.length === 0 ? {} : { tools }),
      })
    }
    return entries.length === 0 ? null : entries
  } catch {
    // A schema we do not recognize, a locked file, anything — the review stands without it.
    return null
  } finally {
    db.close()
  }
}
