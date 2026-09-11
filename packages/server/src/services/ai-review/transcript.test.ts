import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import Database from "better-sqlite3"
import { afterEach, describe, expect, test } from "vitest"
import {
  MAX_TRANSCRIPT_ENTRIES,
  transcriptFromClaudeConfigDir,
  transcriptFromOpencodeDataDir,
} from "./transcript.js"

const dirs: string[] = []
afterEach(() => {
  dirs.splice(0)
})

const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "samskara-transcript-test-"))
  dirs.push(dir)
  return dir
}

describe("transcriptFromClaudeConfigDir", () => {
  test("reads the newest project transcript into role-ordered entries with tool calls", async () => {
    const configDir = scratch()
    const projectDir = join(configDir, "projects", "-tmp-samskara-ai-review-x")
    mkdirSync(projectDir, { recursive: true })
    const lines = [
      JSON.stringify({
        type: "user",
        timestamp: "2026-08-30T17:00:00Z",
        message: { role: "user", content: [{ type: "text", text: "review the session" }] },
      }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-08-30T17:00:05Z",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Reading the export first." },
            { type: "tool_use", name: "Read", input: { file_path: "/work/session.json" } },
          ],
        },
      }),
      "not json at all",
      JSON.stringify({ type: "system" }),
    ]
    writeFileSync(join(projectDir, "s-1.jsonl"), `${lines.join("\n")}\n`)

    const entries = await transcriptFromClaudeConfigDir(configDir)
    expect(entries).not.toBeNull()
    expect(entries).toHaveLength(2)
    expect(entries?.[0]).toMatchObject({ role: "user", text: "review the session" })
    expect(entries?.[1]).toMatchObject({
      role: "assistant",
      text: "Reading the export first.",
    })
    expect(entries?.[1]?.tools).toEqual([{ name: "Read", input: "/work/session.json" }])
  })

  test("returns null when no transcript exists", async () => {
    expect(await transcriptFromClaudeConfigDir(scratch())).toBeNull()
  })

  test("caps the number of entries", async () => {
    const configDir = scratch()
    const projectDir = join(configDir, "projects", "p")
    mkdirSync(projectDir, { recursive: true })
    const lines: string[] = []
    for (let i = 0; i < MAX_TRANSCRIPT_ENTRIES + 50; i += 1) {
      lines.push(
        JSON.stringify({
          type: "user",
          message: { role: "user", content: [{ type: "text", text: `line ${i}` }] },
        }),
      )
    }
    writeFileSync(join(projectDir, "s-1.jsonl"), `${lines.join("\n")}\n`)

    const entries = await transcriptFromClaudeConfigDir(configDir)
    expect(entries).toHaveLength(MAX_TRANSCRIPT_ENTRIES)
  })
})

describe("transcriptFromOpencodeDataDir", () => {
  test("reads the newest session's messages and parts into role-ordered entries", async () => {
    const dataDir = scratch()
    mkdirSync(join(dataDir, "opencode"), { recursive: true })
    const db = new Database(join(dataDir, "opencode", "opencode.db"))
    db.exec(
      "CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, title TEXT, time_created INTEGER, time_updated INTEGER, agent TEXT, model TEXT)",
    )
    db.exec(
      "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT)",
    )
    db.exec(
      "CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT)",
    )
    db.prepare(
      "INSERT INTO session (id, parent_id, title, time_created, time_updated) VALUES ('s1', NULL, 'review run', 1, 10)",
    ).run()
    db.prepare(
      "INSERT INTO message (id, session_id, time_created, data) VALUES ('m1', 's1', 2, ?)",
    ).run(JSON.stringify({ role: "user" }))
    db.prepare(
      "INSERT INTO part (id, message_id, session_id, time_created, data) VALUES ('p1', 'm1', 's1', 3, ?)",
    ).run(JSON.stringify({ type: "text", text: "review this export" }))
    db.prepare(
      "INSERT INTO message (id, session_id, time_created, data) VALUES ('m2', 's1', 4, ?)",
    ).run(JSON.stringify({ role: "assistant" }))
    db.prepare(
      "INSERT INTO part (id, message_id, session_id, time_created, data) VALUES ('p2', 'm2', 's1', 5, ?)",
    ).run(
      JSON.stringify({
        type: "tool",
        tool: "bash",
        state: { status: "completed", input: { command: "cat session.json" } },
      }),
    )
    db.prepare(
      "INSERT INTO part (id, message_id, session_id, time_created, data) VALUES ('p3', 'm2', 's1', 6, ?)",
    ).run(JSON.stringify({ type: "text", text: "The export reads clean." }))
    db.close()

    const entries = await transcriptFromOpencodeDataDir(dataDir)
    expect(entries).not.toBeNull()
    expect(entries).toHaveLength(2)
    expect(entries?.[0]).toMatchObject({ role: "user", text: "review this export" })
    expect(entries?.[1]).toMatchObject({ role: "assistant", text: "The export reads clean." })
    expect(entries?.[1]?.tools).toEqual([{ name: "bash", input: "cat session.json" }])
  })

  test("returns null when the data dir holds no opencode database", async () => {
    expect(await transcriptFromOpencodeDataDir(scratch())).toBeNull()
  })
})
