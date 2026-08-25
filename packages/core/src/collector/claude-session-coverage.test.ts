import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "vitest"
import { buildClaudeSessionCoverage } from "./claude-session-coverage.js"

describe("buildClaudeSessionCoverage", () => {
  test("includes future subagent transcripts and excludes workflow journals", async () => {
    const root = await mkdtemp(join(tmpdir(), "samskara-coverage-"))
    const bucket = join(root, "encoded-project")
    const main = join(bucket, "sess-1.jsonl")
    const future = join(bucket, "sess-1", "subagents", "workflows", "wf-1", "trace.jsonl")
    const journal = join(bucket, "sess-1", "subagents", "workflows", "wf-1", "journal.jsonl")
    await mkdir(join(future, ".."), { recursive: true })
    await writeFile(main, `${JSON.stringify({ cwd: "/work/app", type: "ai-title" })}\n`, "utf8")
    await writeFile(future, `${JSON.stringify({ type: "future", token: "secret" })}\n`, "utf8")
    await writeFile(journal, `${JSON.stringify({ type: "started" })}\n`, "utf8")

    const report = await buildClaudeSessionCoverage({ sessionId: "sess-1", discoveryRoot: root })

    expect(report.agentTranscriptCount).toBe(1)
    expect(report.tracks.map((track) => track.sourceRelativePath)).toEqual([
      "sess-1.jsonl",
      "sess-1/subagents/workflows/wf-1/trace.jsonl",
    ])
    expect(report.totals).toMatchObject({ sourceLineCount: 2, parsedRecordCount: 2 })
  })
})
