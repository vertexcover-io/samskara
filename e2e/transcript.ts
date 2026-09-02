import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

/**
 * Writes Claude Code transcript files the way Claude itself does, so the CLI watcher
 * discovers them through its real glob rather than through a test seam.
 *
 * Layout mirrors the real one exactly:
 *   <home>/.claude/projects/<encoded-cwd>/<sessionId>.jsonl
 *   <home>/.claude/projects/<encoded-cwd>/<sessionId>/subagents/agent-<agentId>.jsonl
 */

export type TranscriptLine = Record<string, unknown>

export type TranscriptWriter = {
  readonly home: string
  readonly projectDir: string
  readonly cwd: string
  readonly sessionId: string
  readonly mainPath: string
  /** Appends lines to the main transcript, as Claude does mid-session. */
  append(lines: ReadonlyArray<TranscriptLine>): Promise<void>
  /** Appends lines to a subagent sidecar track, creating its meta sidecar on first write. */
  appendSubagent(
    agentId: string,
    lines: ReadonlyArray<TranscriptLine>,
    meta?: Record<string, unknown>,
  ): Promise<void>
}

/** Claude encodes a cwd into a directory name by flattening every separator to `-`. */
export const encodeProjectDir = (cwd: string): string => cwd.replace(/[/\\]/g, "-")

const iso = (offsetMinutes: number): string =>
  new Date(Date.UTC(2026, 5, 1, 12, offsetMinutes)).toISOString()

/**
 * A user turn as Claude writes it: `type: "user"` with a string content body.
 * Normalizes to one `message` row with role `user`.
 */
export const userLine = (text: string, minute: number): TranscriptLine => ({
  type: "user",
  uuid: crypto.randomUUID(),
  timestamp: iso(minute),
  sessionId: "placeholder",
  message: { role: "user", content: text },
})

/**
 * An assistant turn with a text block and usage. Normalizes to a `message` row
 * with role `assistant` plus token usage attached to that row.
 */
export const assistantLine = (text: string, minute: number): TranscriptLine => ({
  type: "assistant",
  uuid: crypto.randomUUID(),
  timestamp: iso(minute),
  message: {
    role: "assistant",
    model: "claude-opus-5",
    content: [{ type: "text", text }],
    usage: { input_tokens: 120, output_tokens: 45, cache_read_input_tokens: 0 },
  },
})

/**
 * An assistant turn carrying a tool_use block. Normalizes to a `toolCall` row.
 */
export const toolCallLine = (
  toolId: string,
  name: string,
  input: Record<string, unknown>,
  minute: number,
): TranscriptLine => ({
  type: "assistant",
  uuid: crypto.randomUUID(),
  timestamp: iso(minute),
  message: {
    role: "assistant",
    model: "claude-opus-5",
    content: [{ type: "tool_use", id: toolId, name, input }],
  },
})

/**
 * The matching tool_result, which Claude writes back on a `user` line.
 * Normalizes to a `toolResult` row.
 */
export const toolResultLine = (
  toolId: string,
  content: unknown,
  minute: number,
): TranscriptLine => ({
  type: "user",
  uuid: crypto.randomUUID(),
  timestamp: iso(minute),
  message: {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: toolId, content }],
  },
})

/**
 * A `file-history-delta` line — Claude Code's record of the backup it took before editing a
 * file. No consumer reads the pointer it carries; it is captured only to prove a transcript that
 * contains one still ingests normally, as a bare timeline event.
 *
 * The edited file is named `trackingPath`, matching the real wire format. A fixture that used
 * `path` here passed while production silently resolved no bases at all.
 */
export const deltaLine = (
  path: string,
  backupFileName: string | null,
  minute: number,
): TranscriptLine => ({
  type: "file-history-delta",
  uuid: crypto.randomUUID(),
  timestamp: iso(minute),
  trackingPath: path,
  backup: { backupFileName, version: 1, backupTime: iso(minute) },
})

/** `originalFile` is the content just before this write, and is absent for a large file. */
export const writeResultLine = (
  toolId: string,
  filePath: string,
  options: {
    readonly type?: "create" | "update"
    readonly originalFile?: string | null
  },
  minute: number,
): TranscriptLine => ({
  type: "user",
  uuid: crypto.randomUUID(),
  timestamp: iso(minute),
  message: {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: toolId, content: "OK" }],
  },
  toolUseResult: {
    filePath,
    ...(options.type === undefined ? {} : { type: options.type }),
    ...(options.originalFile === undefined ? {} : { originalFile: options.originalFile }),
  },
})

/** A `summary` line, which normalizes to a `systemEvent` row with subType `summary`. */
export const summaryLine = (summary: string, minute: number): TranscriptLine => ({
  type: "summary",
  uuid: crypto.randomUUID(),
  timestamp: iso(minute),
  summary,
})

/**
 * A tool call whose input carries credentials, as a real transcript does when an agent
 * runs an authenticated request. The collector must redact these before upload: the whole
 * line is persisted to the `raw` jsonb column, so a miss writes secrets to the database.
 *
 * Key spellings deliberately vary -- SENSITIVE_KEYS matches case-insensitively and ignores
 * `_`/`-`, and `note` proves free text is left alone rather than blanket-scrubbed.
 */
export const secretBearingLine = (minute: number): TranscriptLine => ({
  type: "assistant",
  uuid: crypto.randomUUID(),
  timestamp: iso(minute),
  message: {
    role: "assistant",
    model: "claude-opus-5",
    content: [
      {
        type: "tool_use",
        id: "tool-secret-1",
        name: "Bash",
        input: {
          token: "tok-live-DEADBEEF",
          Authorization: "Bearer AUTH-DEADBEEF",
          api_key: "key-DEADBEEF",
          "client-secret": "cs-DEADBEEF",
          nested: { refreshToken: "rt-DEADBEEF", tokenizer: "keep-me" },
          note: "the literal word token appears here and must survive",
        },
      },
    ],
  },
})

const appendLines = async (
  path: string,
  sessionId: string,
  cwd: string,
  lines: ReadonlyArray<TranscriptLine>,
): Promise<void> => {
  await mkdir(dirname(path), { recursive: true })
  // Every line carries sessionId and cwd, exactly as Claude writes them: the collector
  // reads cwd from transcript content to resolve the project, never from the dir name.
  const body = lines.map((line) => `${JSON.stringify({ ...line, sessionId, cwd })}\n`).join("")
  await writeFile(path, body, { flag: "a", encoding: "utf8" })
}

export const createTranscriptWriter = (options: {
  readonly home: string
  readonly cwd: string
  readonly sessionId: string
}): TranscriptWriter => {
  const { home, cwd, sessionId } = options
  const projectDir = join(home, ".claude", "projects", encodeProjectDir(cwd))
  const mainPath = join(projectDir, `${sessionId}.jsonl`)
  const written = new Set<string>()

  return {
    home,
    projectDir,
    cwd,
    sessionId,
    mainPath,
    append: (lines) => appendLines(mainPath, sessionId, cwd, lines),
    appendSubagent: async (agentId, lines, meta) => {
      const path = join(projectDir, sessionId, "subagents", `agent-${agentId}.jsonl`)
      if (meta && !written.has(agentId)) {
        written.add(agentId)
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path.replace(/\.jsonl$/, ".meta.json"), JSON.stringify(meta), "utf8")
      }
      await appendLines(path, sessionId, cwd, lines)
    },
  }
}

export const customTitleLine = (title: string): TranscriptLine => ({
  type: "custom-title",
  customTitle: title,
})

export const aiTitleLine = (title: string): TranscriptLine => ({
  type: "ai-title",
  aiTitle: title,
})
