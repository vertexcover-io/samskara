import { mkdir, mkdtemp, readFile, rename, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "vitest"
import type { ChangedFile } from "../types.js"
import { createClaudePlugin, normalizeClaude, readClaudeSidecar } from "./claude.js"

const nodeFs = {
  readFile: (path: string) => readFile(path, "utf8"),
  writeFile: (path: string, data: string) => writeFile(path, data, "utf8"),
  rename,
  stat: async (path: string) => {
    const s = await stat(path)
    return { size: s.size, mtimeMs: s.mtimeMs }
  },
}

const assistantLine = {
  uuid: "line-1",
  sessionId: "sess-1",
  timestamp: "2026-07-23T00:00:00.000Z",
  message: {
    role: "assistant",
    model: "claude-opus-4-8",
    usage: { input_tokens: 120, output_tokens: 40, cache_read_input_tokens: 8 },
    content: [
      { type: "text", text: "hello" },
      { type: "tool_use", id: "toolu_1", name: "Read", input: { path: "x" } },
      { type: "tool_use", id: "toolu_2", name: "Grep", input: { q: "y" } },
    ],
  },
}

const userToolResultLine = {
  uuid: "line-2",
  sessionId: "sess-1",
  timestamp: "2026-07-23T00:00:01.000Z",
  message: {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok", is_error: false }],
  },
}

describe("normalizeClaude", () => {
  test("fans an assistant line into text + N tool_use messages", () => {
    const msgs = normalizeClaude(assistantLine, 1)
    expect(msgs).toHaveLength(3)
    expect(msgs.map((m) => m.msgType)).toEqual(["assistant", "toolCall", "toolCall"])
    expect(msgs.map((m) => m.subIndex)).toEqual([0, 1, 2])
    expect(msgs.every((m) => m.lineUuid === "line-1")).toBe(true)
    expect(msgs[1]?.toolCall).toEqual({ id: "toolu_1", name: "Read", input: { path: "x" } })
  })

  test("maps token usage and derives provider", () => {
    const [first] = normalizeClaude(assistantLine, 1)
    expect(first?.tokens).toEqual({ input: 120, output: 40, cached: 8, thinking: 0 })
    expect(first?.provider).toBe("anthropic")
  })

  test("produces a toolResult message from a user tool_result block", () => {
    const [msg] = normalizeClaude(userToolResultLine, 2)
    expect(msg?.msgType).toBe("toolResult")
    expect(msg?.toolResult).toEqual({ callId: "toolu_1", output: "ok", status: "success" })
  })

  test("metadata-only line yields no messages", () => {
    expect(normalizeClaude({ uuid: "x", type: "summary" }, 1)).toEqual([])
  })
})

describe("readClaudeSidecar", () => {
  test("returns SubagentInfo when .meta.json is present", async () => {
    const dir = await mkdtemp(join(tmpdir(), "samskara-claude-"))
    await mkdir(join(dir, "subagents"), { recursive: true })
    const transcript = join(dir, "subagents", "agent-af66.jsonl")
    await writeFile(
      transcript.replace(/\.jsonl$/, ".meta.json"),
      JSON.stringify({ agentId: "af66", agentType: "Explore", spawnDepth: 1 }),
      "utf8",
    )

    const info = await readClaudeSidecar(nodeFs, transcript)
    expect(info?.agentId).toBe("af66")
    expect(info?.agentType).toBe("Explore")
  })

  test("returns null when .meta.json is absent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "samskara-claude-"))
    const info = await readClaudeSidecar(nodeFs, join(dir, "missing.jsonl"))
    expect(info).toBeNull()
  })
})

describe("collect", () => {
  test("end-to-end on a subagent transcript yields messages, subagents, and a cursor", async () => {
    const dir = await mkdtemp(join(tmpdir(), "samskara-claude-"))
    await mkdir(join(dir, "subagents"), { recursive: true })
    const path = join(dir, "subagents", "agent-af66.jsonl")
    await writeFile(path, `${JSON.stringify({ ...assistantLine, agentId: "af66" })}\n`, "utf8")
    await writeFile(
      path.replace(/\.jsonl$/, ".meta.json"),
      JSON.stringify({ agentId: "af66", agentType: "Explore" }),
      "utf8",
    )

    const changed: ChangedFile = { path, source: "claude_code", mtime: 1, size: 1 }
    const plugin = createClaudePlugin(nodeFs)
    const result = await plugin.collect(changed, null)

    expect(result.messages).toHaveLength(3)
    expect(result.subagents?.[0]?.agentId).toBe("af66")
    expect(result.newState.cursor.lastLineProcessed).toBe(1)
    expect(result.newState.type).toBe("subagent")
    expect(result.newState.agentId).toBe("af66")
  })
})
