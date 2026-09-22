/**
 * Best-effort capture of what the reviewer agent actually DID inside the sandbox, for the
 * run log persisted alongside the review (AI-9b). The msb microVM writes one JSON record
 * per guest stream event to `<sandbox>/logs/exec.log`; the agent's bash invocations appear
 * as stderr records whose `d` field starts with the escape sequence for `$ ` — the exact
 * shape `scripts/ai-review-watch.sh --peek` parses. This module is that parsing, ported to
 * TS so the server can persist the tail instead of making a human tail the file.
 */

/** The persisted agentLog is capped so a runaway run cannot balloon the review row. */
export const MAX_AGENT_LOG_CHARS = 24 * 1024

/** Per-command truncation, matching the watcher's --peek output width. */
const MAX_COMMAND_CHARS = 200

/** The prompt marker: reset-style ANSI sequence followed by "$ ". */
const PROMPT_PREFIX = "\u001b[0m$ "

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escape sequences is this regex's entire job
const ANSI_RE = /\u001b\[[0-9;]*[A-Za-z]/g

/** Keeps the tail: the most recent commands are the interesting ones when a run went wrong. */
export const capAgentLog = (text: string): string =>
  text.length <= MAX_AGENT_LOG_CHARS
    ? text
    : `…${text.slice(text.length - MAX_AGENT_LOG_CHARS + 1)}`

type ExecLogRecord = { readonly t?: unknown; readonly s?: unknown; readonly d?: unknown }

/**
 * The agent's command lines, one per bash call, each `<t>  <command>` (timestamp, two
 * spaces, the command with newlines flattened to " | " and ANSI stripped) — byte-for-byte
 * the line shape the watcher prints, so muscle memory transfers.
 */
export const agentCommandsFromExecLog = (contents: string): string[] => {
  const commands: string[] = []
  for (const line of contents.split("\n")) {
    const trimmed = line.trim()
    if (trimmed === "") continue
    let record: ExecLogRecord
    try {
      record = JSON.parse(trimmed) as ExecLogRecord
    } catch {
      continue
    }
    if (record.s !== "stderr" || typeof record.d !== "string") continue
    if (!record.d.startsWith(PROMPT_PREFIX)) continue
    const command = record.d
      .slice(PROMPT_PREFIX.length)
      .replaceAll("\n", " | ")
      .replace(ANSI_RE, "")
      .slice(0, MAX_COMMAND_CHARS)
    if (command.trim() === "") continue
    commands.push(`${String(record.t ?? "")}  ${command}`)
  }
  return commands
}

/** exec.log contents → the capped agentLog string persisted on the run record. */
export const agentLogFromExecLog = (contents: string): string =>
  capAgentLog(agentCommandsFromExecLog(contents).join("\n"))
