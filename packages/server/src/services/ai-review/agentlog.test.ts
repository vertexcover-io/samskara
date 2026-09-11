import { describe, expect, test } from "vitest"
import { agentLogFromExecLog, capAgentLog, MAX_AGENT_LOG_CHARS } from "./agentlog.js"

/** One exec.log record as msb writes it: {t, s, d, id} — d is the raw stream chunk. */
const execLine = (d: string, s = "stderr"): string =>
  JSON.stringify({ t: 1_755_700_000, s, d, id: 7 })

const PROMPT_PREFIX = "\u001b[0m$ "

describe("agentCommandsFromExecLog (via agentLogFromExecLog)", () => {
  test("AL1: extracts bash prompt lines from stderr, skipping noise and non-prompts", () => {
    const log = [
      execLine(`${PROMPT_PREFIX}ls -la /work`),
      execLine("some stdout chatter", "stdout"),
      execLine("stderr but not a prompt"),
      execLine(
        `${PROMPT_PREFIX}python3 -c 'import xml.etree.ElementTree as ET; ET.parse("review.xml")'`,
      ),
      "not json at all",
      execLine(`${PROMPT_PREFIX}exit 0`),
    ].join("\n")
    const lines = agentLogFromExecLog(log).split("\n")
    expect(lines).toHaveLength(3)
    expect(lines[0]).toContain("ls -la /work")
    expect(lines[1]).toContain("ET.parse")
    expect(lines[2]).toContain("exit 0")
    // The timestamp prefix survives so the log is still a timeline of the agent's run.
    expect(lines[0]).toMatch(/^1755700000\s{2}/)
  })

  test("AL2: a multi-line heredoc prompt collapses to one line with | separators and ANSI stripped", () => {
    const command = "cat <<'EOF' > review.xml\n<review>\nstuff\nEOF"
    const log = execLine(`${PROMPT_PREFIX}${command}\u001b[32m done`)
    const line = agentLogFromExecLog(log)
    expect(line).toContain(" | ")
    expect(line).not.toContain("\n")
    expect(line).not.toContain("\u001b[32m")
  })

  test("AL3: each command is truncated to 200 chars, like the watcher's --peek", () => {
    const long = "x".repeat(500)
    const line = agentLogFromExecLog(execLine(PROMPT_PREFIX + long))
    // timestamp (10) + two spaces + 200 command chars
    expect(line.length).toBeLessThanOrEqual(10 + 2 + 200)
    expect(line.endsWith("xxx")).toBe(true)
  })

  test("AL4: an empty exec.log yields an empty agentLog", () => {
    expect(agentLogFromExecLog("")).toBe("")
  })
})

describe("capAgentLog", () => {
  test("AL5: short text passes through unchanged; long text keeps the tail within the cap", () => {
    expect(capAgentLog("short")).toBe("short")
    const huge = `${"a".repeat(MAX_AGENT_LOG_CHARS)}THE-END`
    const capped = capAgentLog(huge)
    expect(capped.length).toBeLessThanOrEqual(MAX_AGENT_LOG_CHARS)
    expect(capped.endsWith("THE-END")).toBe(true)
    expect(capped.startsWith("…")).toBe(true)
  })
})
