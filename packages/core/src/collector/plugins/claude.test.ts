import { mkdir, mkdtemp, readFile, rename, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "vitest"
import type { ProjectIdentity } from "../../ingest/types.js"
import { createLogger } from "../../logging.js"
import type { CheckpointStore, CollectDeps } from "../types.js"
import {
  classifyClaudePath,
  createClaudePlugin,
  lineUuidFor,
  normalizeClaude,
  readClaudeSidecar,
  redactJson,
  stableJson,
} from "./claude.js"

const nodeFs = {
  readFile: (path: string) => readFile(path, "utf8"),
  writeFile: (path: string, data: string) => writeFile(path, data, "utf8"),
  rename,
  stat: async (path: string) => {
    const s = await stat(path)
    return { size: s.size, mtimeMs: s.mtimeMs }
  },
}

const project: ProjectIdentity = { name: "widget", slug: "acme-widget" }

const collectDeps = (
  glob: ReadonlyArray<string>,
  over: Partial<CollectDeps> = {},
): CollectDeps => ({
  fs: nodeFs,
  glob: async () => glob,
  resolveProject: async () => project,
  log: createLogger({ service: "claude-test" }, { level: "silent" }),
  ...over,
})

const empty: CheckpointStore = { checkpoints: {} }

const assistantLine = {
  uuid: "line-1",
  sessionId: "sess-1",
  cwd: "/work/app",
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

const stringUserLine = {
  uuid: "line-user-string",
  sessionId: "sess-1",
  timestamp: "2026-07-23T00:00:02.000Z",
  message: { role: "user", content: "Review this design." },
}

const arrayUserTextLine = {
  uuid: "line-user-array",
  sessionId: "sess-1",
  timestamp: "2026-07-23T00:00:03.000Z",
  message: { role: "user", content: [{ type: "text", text: "Continue." }] },
}

describe("normalizeClaude", () => {
  test("S1: unknown and structurally invalid objects emit deterministic custom messages", () => {
    const context = { sessionId: "sess-1", trackId: "main", lineNumber: 7 } as const
    const fixtures = [
      [{ type: "future" }, "future"],
      [{}, "unknown"],
      [{ type: "system", subtype: 4 }, "system"],
      [{ type: "attachment", attachment: {} }, "attachment"],
      [{ type: "progress", data: {} }, "progress"],
      [{ type: "user", message: { role: "user", content: [] } }, "message.content"],
      [{ type: "user", message: { role: "user", content: [7] } }, "message.content"],
    ] as const

    for (const [fixture, subType] of fixtures) {
      const messages = normalizeClaude(fixture, context)
      expect(messages).toHaveLength(1)
      expect(messages[0]).toMatchObject({ msgType: "custom", subType, trackId: "main" })
      expect(messages[0]?.timestamp).toBeUndefined()
    }

    const redacted = { type: "future", token: "[Redacted]" }
    expect(lineUuidFor(context, redacted)).toBe("3e00dad3-a91e-57cd-a458-156fe52cf8db")
    expect(lineUuidFor(context, redacted)).toBe(lineUuidFor(context, redacted))
  })

  test("S2: mixed text, unknown, non-object, and tool content preserves all four positions", () => {
    const messages = normalizeClaude(
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "hello" },
            { type: "future_block" },
            null,
            { type: "tool_use", id: "call-1", name: "Read", input: { path: "x" } },
          ],
        },
      },
      { sessionId: "sess-1", trackId: "main", lineNumber: 1 },
    )

    expect(messages.map((message) => message.msgType)).toEqual([
      "message",
      "custom",
      "custom",
      "toolCall",
    ])
    expect(messages.map((message) => message.subIndex)).toEqual([0, 1, 2, 3])
    expect(messages[1]).toMatchObject({ subType: "future_block" })
    expect(messages[2]).toMatchObject({ subType: "message.content" })
  })

  test("S3: structural redaction precedes stable identity without rewriting free text", () => {
    const source = {
      token: "secret-1",
      Authorization: "secret-2",
      nested: [{ api_key: "secret-3", tokenizer: "keep" }],
      note: "token=secret-1",
      type: "future",
    }
    const redacted = redactJson(source)

    expect(redacted).toEqual({
      token: "[Redacted]",
      Authorization: "[Redacted]",
      nested: [{ api_key: "[Redacted]", tokenizer: "keep" }],
      note: "token=secret-1",
      type: "future",
    })
    expect(stableJson({ b: 1, a: [{ d: 2, c: 1 }] })).toBe('{"a":[{"c":1,"d":2}],"b":1}')
    expect(source.token).toBe("secret-1")
  })

  test("S4: main, nested agents, workflow journals, and future tracks classify deterministically", () => {
    const root = "/home/me/.claude/projects"
    expect(classifyClaudePath(`${root}/-Users-me-app/sess-1.jsonl`, root)).toEqual({
      sessionId: "sess-1",
      trackId: "main",
      sourceRelativePath: "sess-1.jsonl",
    })
    expect(
      classifyClaudePath(`${root}/bucket/sess-1/subagents/workflows/wf/agent-a1.jsonl`, root),
    ).toEqual({
      sessionId: "sess-1",
      trackId: "agent:a1",
      agentId: "a1",
      sourceRelativePath: "sess-1/subagents/workflows/wf/agent-a1.jsonl",
    })
    expect(
      classifyClaudePath(`${root}/bucket/sess-1/subagents/workflows/wf/journal.jsonl`, root),
    ).toBeNull()
    const future = classifyClaudePath(`${root}/bucket/sess-1/subagents/future/trace.jsonl`, root)
    expect(future).toMatchObject({
      sessionId: "sess-1",
      sourceRelativePath: "sess-1/subagents/future/trace.jsonl",
    })
    expect(future?.agentId).toMatch(/^path-[a-f0-9]{64}$/)
    expect(future?.trackId).toBe(`agent:${future?.agentId}`)
  })
  test("fans an assistant line into text + N tool_use messages", () => {
    const msgs = normalizeClaude(assistantLine)
    expect(msgs).toHaveLength(3)
    expect(msgs.map((m) => m.msgType)).toEqual(["message", "toolCall", "toolCall"])
    expect(msgs.map((m) => m.subIndex)).toEqual([0, 1, 2])
    expect(msgs[1]?.msgType === "toolCall" ? msgs[1].details : undefined).toEqual({
      callId: "toolu_1",
      name: "Read",
      input: { path: "x" },
    })
  })

  test("maps token usage and derives provider", () => {
    const [first] = normalizeClaude(assistantLine)
    expect(first?.msgType === "message" ? first.tokens : undefined).toEqual({
      input: 120,
      output: 40,
      cached: 8,
      thinking: 0,
    })
    expect(first?.provider).toBe("anthropic")
  })

  test("produces a toolResult message from a user tool_result block", () => {
    const [msg] = normalizeClaude(userToolResultLine)
    expect(msg?.msgType).toBe("toolResult")
    expect(msg?.msgType === "toolResult" ? msg.details : undefined).toEqual({
      callId: "toolu_1",
      output: "ok",
      status: "success",
    })
  })

  test.each([
    ["string content", stringUserLine, "Review this design."],
    ["text block", arrayUserTextLine, "Continue."],
  ])("classifies real-format user %s as a user message", (_format, line, content) => {
    const messages = normalizeClaude(line)
    expect(messages).toHaveLength(1)
    expect(messages[0]?.msgType).toBe("message")
    expect(messages[0]?.msgType === "message" ? messages[0].role : undefined).toBe("user")
    expect(messages[0]?.msgType === "message" ? messages[0].content : undefined).toEqual({
      type: "text",
      value: content,
    })
  })

  test("metadata-only line yields a custom message", () => {
    expect(normalizeClaude({ uuid: "x", type: "summary" })[0]).toMatchObject({
      msgType: "custom",
      subType: "summary",
    })
  })
})

describe("readClaudeSidecar", () => {
  test("combines the filename agent id with real Claude sidecar metadata", async () => {
    const dir = await mkdtemp(join(tmpdir(), "samskara-claude-"))
    await mkdir(join(dir, "subagents"), { recursive: true })
    const transcript = join(dir, "subagents", "agent-af66.jsonl")
    await writeFile(
      transcript.replace(/\.jsonl$/, ".meta.json"),
      JSON.stringify({
        agentType: "general-purpose",
        description: "Review the design",
        toolUseId: "toolu_spawn",
        spawnDepth: 1,
      }),
      "utf8",
    )

    const info = await readClaudeSidecar(nodeFs, transcript)
    expect(info).toEqual({
      agentId: "af66",
      agentType: "general-purpose",
      description: "Review the design",
      spawnDepth: 1,
      spawnToolUseId: "toolu_spawn",
    })
  })

  test("returns filename-derived agent info when metadata is absent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "samskara-claude-"))
    const transcript = join(dir, "subagents", "agent-af66.jsonl")
    const info = await readClaudeSidecar(nodeFs, transcript)
    expect(info).toEqual({ agentId: "af66" })
  })

  test("returns null for a non-subagent path when metadata is absent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "samskara-claude-"))
    const info = await readClaudeSidecar(nodeFs, join(dir, "missing.jsonl"))
    expect(info).toBeNull()
  })
})

describe("collect", () => {
  test("groups a main file into a session batch with a main track and records", async () => {
    const dir = await mkdtemp(join(tmpdir(), "samskara-claude-"))
    const path = join(dir, "sess-1.jsonl")
    await writeFile(path, `${JSON.stringify(assistantLine)}\n`, "utf8")

    const plugin = createClaudePlugin(nodeFs)
    const batches = await plugin.collect(empty, collectDeps([path]))

    expect(batches).toHaveLength(1)
    expect(batches[0]?.sessionId).toBe("sess-1")
    const track = batches[0]?.tracks[0]
    expect(track?.type).toBe("main")
    expect(track?.records).toHaveLength(1)
    expect(track?.records[0]?.lineUuid).toMatch(/^[0-9a-f-]{36}$/)
    expect(track?.records[0]?.lineNumber).toBe(1)
    expect(track?.records[0]?.messages).toHaveLength(3)
    expect(track?.kind === "ingest" ? track.project : undefined).toEqual(project)
    expect(track?.checkpointKey).toBe(path)
    expect(track?.checkpointAt(1).lineProcessed).toBe(1)
    expect(track?.checkpointAt(1).source).toBe("claude_code")
  })

  test("a real-format subagent file yields a subagent track carrying agent info", async () => {
    const dir = await mkdtemp(join(tmpdir(), "samskara-claude-"))
    await mkdir(join(dir, "sess-1", "subagents"), { recursive: true })
    const path = join(dir, "sess-1", "subagents", "agent-af66.jsonl")
    await writeFile(path, `${JSON.stringify({ ...assistantLine, agentId: "af66" })}\n`, "utf8")
    await writeFile(
      path.replace(/\.jsonl$/, ".meta.json"),
      JSON.stringify({ agentType: "Explore", toolUseId: "toolu_spawn", spawnDepth: 1 }),
      "utf8",
    )

    const plugin = createClaudePlugin(nodeFs)
    const batches = await plugin.collect(empty, collectDeps([path]))
    const track = batches[0]?.tracks[0]
    expect(track?.type).toBe("subagent")
    if (track?.type !== "subagent") throw new Error("expected subagent")
    expect(track.agent).toEqual({
      agentId: "af66",
      agentType: "Explore",
      description: undefined,
      spawnDepth: 1,
      spawnToolUseId: "toolu_spawn",
    })
  })

  test("main + subagent of one session group into a single batch, main first", async () => {
    const dir = await mkdtemp(join(tmpdir(), "samskara-claude-"))
    await mkdir(join(dir, "sess-1", "subagents"), { recursive: true })
    const main = join(dir, "sess-1.jsonl")
    const sub = join(dir, "sess-1", "subagents", "agent-af66.jsonl")
    await writeFile(main, `${JSON.stringify(assistantLine)}\n`, "utf8")
    await writeFile(sub, `${JSON.stringify({ ...assistantLine, agentId: "af66" })}\n`, "utf8")
    await writeFile(
      sub.replace(/\.jsonl$/, ".meta.json"),
      JSON.stringify({ agentId: "af66" }),
      "utf8",
    )

    const plugin = createClaudePlugin(nodeFs)
    const batches = await plugin.collect(empty, collectDeps([sub, main]))
    expect(batches).toHaveLength(1)
    expect(batches[0]?.tracks.map((t) => t.type)).toEqual(["main", "subagent"])
  })

  test("skips an unchanged file (matching mtime + size) without reading it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "samskara-claude-"))
    const path = join(dir, "sess-1.jsonl")
    await writeFile(path, `${JSON.stringify(assistantLine)}\n`, "utf8")
    const s = await stat(path)

    const prev: CheckpointStore = {
      checkpoints: {
        [path]: {
          filePath: path,
          lastUpdatedAt: "2026-07-24T00:00:00.000Z",
          source: "claude_code",
          mtime: s.mtimeMs,
          size: s.size,
          lineProcessed: 1,
        },
      },
    }

    const plugin = createClaudePlugin(nodeFs)
    const batches = await plugin.collect(prev, collectDeps([path]))
    expect(batches).toHaveLength(0)
  })

  test("reads only from the stored watermark when a file has grown", async () => {
    const dir = await mkdtemp(join(tmpdir(), "samskara-claude-"))
    const path = join(dir, "sess-1.jsonl")
    await writeFile(path, `${JSON.stringify(assistantLine)}\n`, "utf8")
    await writeFile(
      path,
      `${JSON.stringify(assistantLine)}\n${JSON.stringify({ ...userToolResultLine, cwd: "/work/app" })}\n`,
      "utf8",
    )

    const prev: CheckpointStore = {
      checkpoints: {
        [path]: {
          filePath: path,
          lastUpdatedAt: "2026-07-24T00:00:00.000Z",
          source: "claude_code",
          mtime: 0,
          size: 0,
          lineProcessed: 1,
        },
      },
    }

    const plugin = createClaudePlugin(nodeFs)
    const batches = await plugin.collect(prev, collectDeps([path]))
    const records = batches[0]?.tracks[0]?.records ?? []
    expect(records).toHaveLength(1)
    expect(records[0]?.lineUuid).toMatch(/^[0-9a-f-]{36}$/)
    expect(records[0]?.lineNumber).toBe(2)
  })

  test("emits no track for a file whose starting dir can't be resolved (no cwd)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "samskara-claude-"))
    const path = join(dir, "no-cwd.jsonl")
    const noCwd = { ...assistantLine }
    // biome-ignore lint/performance/noDelete: test fixture
    delete (noCwd as { cwd?: string }).cwd
    await writeFile(path, `${JSON.stringify({ ...assistantLine, cwd: undefined })}\n`, "utf8")

    const plugin = createClaudePlugin(nodeFs)
    const batches = await plugin.collect(empty, collectDeps([path]))
    expect(batches).toHaveLength(0)
  })
})
