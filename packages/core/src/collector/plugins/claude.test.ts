import { mkdir, mkdtemp, readFile, rename, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "vitest"
import type { ProjectIdentity } from "../../ingest/types.js"
import type { CheckpointStore, CollectDeps } from "../types.js"
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

const project: ProjectIdentity = { name: "widget", slug: "acme-widget" }

const collectDeps = (
  glob: ReadonlyArray<string>,
  over: Partial<CollectDeps> = {},
): CollectDeps => ({
  fs: nodeFs,
  glob: async () => glob,
  resolveProject: async () => project,
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
  test("fans an assistant line into text + N tool_use messages", () => {
    const msgs = normalizeClaude(assistantLine)
    expect(msgs).toHaveLength(3)
    expect(msgs.map((m) => m.msgType)).toEqual(["assistant", "toolCall", "toolCall"])
    expect(msgs.map((m) => m.subIndex)).toEqual([0, 1, 2])
    expect(msgs[1]?.toolCall).toEqual({ id: "toolu_1", name: "Read", input: { path: "x" } })
  })

  test("maps token usage and derives provider", () => {
    const [first] = normalizeClaude(assistantLine)
    expect(first?.tokens).toEqual({ input: 120, output: 40, cached: 8, thinking: 0 })
    expect(first?.provider).toBe("anthropic")
  })

  test("produces a toolResult message from a user tool_result block", () => {
    const [msg] = normalizeClaude(userToolResultLine)
    expect(msg?.msgType).toBe("toolResult")
    expect(msg?.toolResult).toEqual({ callId: "toolu_1", output: "ok", status: "success" })
  })

  test.each([
    ["string content", stringUserLine, "Review this design."],
    ["text block", arrayUserTextLine, "Continue."],
  ])("classifies real-format user %s as a user message", (_format, line, content) => {
    const messages = normalizeClaude(line)
    expect(messages).toHaveLength(1)
    expect(messages[0]?.msgType).toBe("user")
    expect(messages[0]?.content).toBe(content)
  })

  test("metadata-only line yields no messages", () => {
    expect(normalizeClaude({ uuid: "x", type: "summary" })).toEqual([])
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
    expect(track?.records[0]?.lineUuid).toBe("line-1")
    expect(track?.records[0]?.lineNumber).toBe(1)
    expect(track?.records[0]?.messages).toHaveLength(3)
    expect(track?.project).toEqual(project)
    expect(track?.checkpointKey).toBe(path)
    expect(track?.checkpointAt(1).lineProcessed).toBe(1)
    expect(track?.checkpointAt(1).source).toBe("claude_code")
  })

  test("a real-format subagent file yields a subagent track carrying agent info", async () => {
    const dir = await mkdtemp(join(tmpdir(), "samskara-claude-"))
    await mkdir(join(dir, "subagents"), { recursive: true })
    const path = join(dir, "subagents", "agent-af66.jsonl")
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
    await mkdir(join(dir, "subagents"), { recursive: true })
    const main = join(dir, "sess-1.jsonl")
    const sub = join(dir, "subagents", "agent-af66.jsonl")
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
    expect(records[0]?.lineUuid).toBe("line-2")
    expect(records[0]?.lineNumber).toBe(2)
  })

  test("drops a file whose project is not enabled before normalizing its records", async () => {
    const dir = await mkdtemp(join(tmpdir(), "samskara-claude-"))
    const path = join(dir, "sess-1.jsonl")
    await writeFile(path, `${JSON.stringify(assistantLine)}\n`, "utf8")

    const plugin = createClaudePlugin(nodeFs)
    const batches = await plugin.collect(
      empty,
      collectDeps([path], { shouldCapture: async () => false }),
    )

    expect(batches).toHaveLength(0)
  })

  test("keeps a file whose project is enabled", async () => {
    const dir = await mkdtemp(join(tmpdir(), "samskara-claude-"))
    const path = join(dir, "sess-1.jsonl")
    await writeFile(path, `${JSON.stringify(assistantLine)}\n`, "utf8")

    const plugin = createClaudePlugin(nodeFs)
    const batches = await plugin.collect(
      empty,
      collectDeps([path], { shouldCapture: async () => true }),
    )

    expect(batches[0]?.tracks[0]?.records).toHaveLength(1)
  })

  test("resolves each distinct cwd once across the files of a cycle", async () => {
    const dir = await mkdtemp(join(tmpdir(), "samskara-claude-"))
    const a = join(dir, "sess-a.jsonl")
    const b = join(dir, "sess-b.jsonl")
    await writeFile(a, `${JSON.stringify(assistantLine)}\n`, "utf8")
    await writeFile(
      b,
      `${JSON.stringify({ ...assistantLine, uuid: "line-b", sessionId: "sess-2" })}\n`,
      "utf8",
    )

    const seen: string[] = []
    const plugin = createClaudePlugin(nodeFs)
    await plugin.collect(
      empty,
      collectDeps([a, b], {
        resolveProject: async (startDir) => {
          seen.push(startDir)
          return project
        },
      }),
    )

    expect(seen).toEqual(["/work/app"])
  })

  test("a disabled project reads one probe file, not every transcript in its directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "samskara-claude-"))
    const dir = join(root, "projects", "-work-app")
    await mkdir(dir, { recursive: true })
    const paths = ["a", "b", "c", "d"].map((n) => join(dir, `sess-${n}.jsonl`))
    await Promise.all(
      paths.map((p, i) =>
        writeFile(
          p,
          `${JSON.stringify({ ...assistantLine, uuid: `u${i}`, sessionId: `sess-${i}` })}\n`,
          "utf8",
        ),
      ),
    )

    const reads: string[] = []
    const countingFs = {
      ...nodeFs,
      readFile: (path: string) => {
        reads.push(path)
        return nodeFs.readFile(path)
      },
    }

    const plugin = createClaudePlugin(countingFs)
    const batches = await plugin.collect(
      empty,
      collectDeps(paths, { fs: countingFs, shouldCapture: async () => false }),
    )

    expect(batches).toHaveLength(0)
    expect(reads).toHaveLength(1)
  })

  test("resolves the project once for a whole session directory, subagents included", async () => {
    const root = await mkdtemp(join(tmpdir(), "samskara-claude-"))
    const dir = join(root, "projects", "-work-app")
    await mkdir(join(dir, "subagents"), { recursive: true })
    const main = join(dir, "sess-1.jsonl")
    const sub = join(dir, "subagents", "agent-af66.jsonl")
    await writeFile(main, `${JSON.stringify(assistantLine)}\n`, "utf8")
    await writeFile(sub, `${JSON.stringify({ ...assistantLine, agentId: "af66" })}\n`, "utf8")
    await writeFile(
      sub.replace(/\.jsonl$/, ".meta.json"),
      JSON.stringify({ agentId: "af66" }),
      "utf8",
    )

    const seen: string[] = []
    const plugin = createClaudePlugin(nodeFs)
    const batches = await plugin.collect(
      empty,
      collectDeps([main, sub], {
        resolveProject: async (startDir) => {
          seen.push(startDir)
          return project
        },
      }),
    )

    expect(seen).toHaveLength(1)
    expect(batches[0]?.tracks.map((t) => t.type)).toEqual(["main", "subagent"])
  })

  test("resolves a directory's project once across cycles, not once per cycle", async () => {
    const root = await mkdtemp(join(tmpdir(), "samskara-claude-"))
    const dir = join(root, "projects", "-work-app")
    await mkdir(dir, { recursive: true })
    const path = join(dir, "sess-1.jsonl")
    await writeFile(path, `${JSON.stringify(assistantLine)}\n`, "utf8")

    const seen: string[] = []
    const deps = collectDeps([path], {
      resolveProject: async (startDir) => {
        seen.push(startDir)
        return project
      },
    })

    const plugin = createClaudePlugin(nodeFs)
    await plugin.collect(empty, deps)
    await writeFile(
      path,
      `${JSON.stringify(assistantLine)}\n${JSON.stringify({ ...assistantLine, uuid: "line-2" })}\n`,
      "utf8",
    )
    await plugin.collect(empty, deps)

    expect(seen).toEqual(["/work/app"])
  })

  test("re-checks enablement every cycle even though the project is cached", async () => {
    const root = await mkdtemp(join(tmpdir(), "samskara-claude-"))
    const dir = join(root, "projects", "-work-app")
    await mkdir(dir, { recursive: true })
    const path = join(dir, "sess-1.jsonl")
    await writeFile(path, `${JSON.stringify(assistantLine)}\n`, "utf8")

    let enabled = false
    const plugin = createClaudePlugin(nodeFs)
    const deps = collectDeps([path], { shouldCapture: async () => enabled })

    expect(await plugin.collect(empty, deps)).toHaveLength(0)
    enabled = true
    expect(await plugin.collect(empty, deps)).toHaveLength(1)
  })

  test("a directory that had no cwd yet still resolves on a later cycle", async () => {
    const root = await mkdtemp(join(tmpdir(), "samskara-claude-"))
    const dir = join(root, "projects", "-work-app")
    await mkdir(dir, { recursive: true })
    const path = join(dir, "sess-1.jsonl")
    const cwdless = JSON.stringify({
      uuid: "line-0",
      sessionId: "sess-1",
      timestamp: "2026-07-23T00:00:00.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
    })
    await writeFile(path, `${cwdless}\n`, "utf8")

    const plugin = createClaudePlugin(nodeFs)
    const deps = collectDeps([path])
    expect(await plugin.collect(empty, deps)).toHaveLength(0)

    await writeFile(path, `${cwdless}\n${JSON.stringify(assistantLine)}\n`, "utf8")
    const batches = await plugin.collect(empty, deps)

    expect(batches.map((b) => b.sessionId)).toEqual(["sess-1"])
  })

  test("a probe file with no cwd does not strand its siblings in the same directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "samskara-claude-"))
    const noCwd = join(dir, "aaa-no-cwd.jsonl")
    const withCwd = join(dir, "bbb-has-cwd.jsonl")
    await writeFile(
      noCwd,
      `${JSON.stringify({ uuid: "n1", sessionId: "sess-n", timestamp: "2026-07-23T00:00:00.000Z", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } })}\n`,
      "utf8",
    )
    await writeFile(withCwd, `${JSON.stringify(assistantLine)}\n`, "utf8")

    const plugin = createClaudePlugin(nodeFs)
    const batches = await plugin.collect(empty, collectDeps([noCwd, withCwd]))

    expect(batches.map((b) => b.sessionId)).toContain("sess-1")
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
