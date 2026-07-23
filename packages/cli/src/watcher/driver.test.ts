import { mkdir, mkdtemp, readFile, rename, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type FileSystem,
  type IngestPayload,
  type ProjectIdentity,
  createClaudePlugin,
} from "@samskara/core"
import { beforeEach, describe, expect, test } from "vitest"
import { type WatcherConfig, type WatcherDeps, runCycle } from "./driver.js"
import { createInMemorySink } from "./sink.js"

const nodeFs: FileSystem = {
  readFile: (path) => readFile(path, "utf8"),
  writeFile: (path, data) => writeFile(path, data, "utf8"),
  rename,
  stat: async (path) => {
    const s = await stat(path)
    return { size: s.size, mtimeMs: s.mtimeMs }
  },
}

const project: ProjectIdentity = { name: "widget", slug: "acme-widget" }

const assistantLine = (uuid: string, sessionId: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    uuid,
    sessionId,
    cwd: "/work/app",
    gitBranch: "main",
    timestamp: "2026-07-23T00:00:00.000Z",
    message: {
      role: "assistant",
      model: "claude-opus-4-8",
      content: [
        { type: "text", text: "hi" },
        { type: "tool_use", id: `toolu_${uuid}`, name: "Read", input: {} },
      ],
    },
    ...extra,
  })

describe("watcher driver", () => {
  let dir: string
  let projects: string
  let config: WatcherConfig

  const deps = (over: Partial<WatcherDeps> = {}): WatcherDeps => ({
    fs: nodeFs,
    clock: { now: () => 0 },
    sink: createInMemorySink(),
    glob: async () => [],
    plugin: createClaudePlugin(nodeFs),
    resolveProject: async () => project,
    ...over,
  })

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "samskara-watch-"))
    projects = join(dir, "projects")
    await mkdir(projects, { recursive: true })
    config = { statePath: join(dir, "state.json"), projectOverride: project }
  })

  test("flushes a grown main file and advances the watermark", async () => {
    const main = join(projects, "sess-1.jsonl")
    await writeFile(main, `${assistantLine("l1", "sess-1")}\n`, "utf8")

    const sink = createInMemorySink()
    const d = deps({ sink, glob: async () => [main] })
    const state = await runCycle(config, d)

    expect(sink.received).toHaveLength(1)
    expect(sink.received[0]?.type).toBe("main")
    expect(sink.received[0]?.messages).toHaveLength(2)
    expect(state.files[main]?.cursor.lastLineProcessed).toBe(1)
  })

  test("restart resumes from the persisted watermark", async () => {
    const main = join(projects, "sess-1.jsonl")
    await writeFile(main, `${assistantLine("l1", "sess-1")}\n`, "utf8")
    const sink1 = createInMemorySink()
    await runCycle(config, deps({ sink: sink1, glob: async () => [main] }))

    const sink2 = createInMemorySink()
    await runCycle(config, deps({ sink: sink2, glob: async () => [main] }))
    expect(sink2.received).toHaveLength(0)

    await writeFile(
      main,
      `${assistantLine("l1", "sess-1")}\n${assistantLine("l2", "sess-1")}\n`,
      "utf8",
    )
    const sink3 = createInMemorySink()
    await runCycle(config, deps({ sink: sink3, glob: async () => [main] }))
    expect(sink3.received).toHaveLength(1)
    expect(sink3.received[0]?.messages.every((m) => m.lineUuid === "l2")).toBe(true)
  })

  test("does not advance the watermark on a 409 and retries next cycle", async () => {
    const sub = join(projects, "subagents", "agent-af66.jsonl")
    await mkdir(join(projects, "subagents"), { recursive: true })
    await writeFile(sub, `${assistantLine("s1", "sess-1", { agentId: "af66" })}\n`, "utf8")

    const rejecting = createInMemorySink(() => 409)
    const state = await runCycle(config, deps({ sink: rejecting, glob: async () => [sub] }))
    expect(state.files[sub]).toBeUndefined()

    const accepting = createInMemorySink(() => 200)
    const next = await runCycle(config, deps({ sink: accepting, glob: async () => [sub] }))
    expect(accepting.received).toHaveLength(1)
    expect(next.files[sub]?.cursor.lastLineProcessed).toBe(1)
  })

  test("orders main files before subagent files", async () => {
    const main = join(projects, "sess-1.jsonl")
    const sub = join(projects, "subagents", "agent-af66.jsonl")
    await mkdir(join(projects, "subagents"), { recursive: true })
    await writeFile(main, `${assistantLine("l1", "sess-1")}\n`, "utf8")
    await writeFile(sub, `${assistantLine("s1", "sess-1", { agentId: "af66" })}\n`, "utf8")

    const sink = createInMemorySink()
    await runCycle(config, deps({ sink, glob: async () => [sub, main] }))
    expect(sink.received.map((p) => p.type)).toEqual(["main", "subagent"])
  })

  test("a torn trailing line is not flushed until completed", async () => {
    const main = join(projects, "sess-1.jsonl")
    await writeFile(
      main,
      `${assistantLine("l1", "sess-1")}\n${assistantLine("l2", "sess-1")}`,
      "utf8",
    )

    const sink = createInMemorySink()
    const state = await runCycle(config, deps({ sink, glob: async () => [main] }))
    expect(sink.received[0]?.messages.every((m) => m.lineUuid === "l1")).toBe(true)
    expect(state.files[main]?.cursor.lastLineProcessed).toBe(1)

    await writeFile(
      main,
      `${assistantLine("l1", "sess-1")}\n${assistantLine("l2", "sess-1")}\n`,
      "utf8",
    )
    const sink2 = createInMemorySink()
    await runCycle(config, deps({ sink: sink2, glob: async () => [main] }))
    expect(sink2.received[0]?.messages.every((m) => m.lineUuid === "l2")).toBe(true)
  })

  test("caps a large first scan and loops until caught up", async () => {
    const main = join(projects, "big.jsonl")
    const lines = Array.from({ length: 2500 }, (_, i) => assistantLine(`l${i + 1}`, "sess-1"))
    await writeFile(main, `${lines.join("\n")}\n`, "utf8")

    const sink = createInMemorySink()
    const state = await runCycle(config, deps({ sink, glob: async () => [main] }))
    expect(sink.received.length).toBeGreaterThanOrEqual(2)
    expect(state.files[main]?.cursor.lastLineProcessed).toBe(2500)
  })

  test("auto-resolves the project from the session cwd when no override is given", async () => {
    const main = join(projects, "sess-1.jsonl")
    await writeFile(main, `${assistantLine("l1", "sess-1")}\n`, "utf8")

    const resolved: ProjectIdentity = { name: "andromeda", slug: "refrens-andromeda" }
    const seenCwds: string[] = []
    const sink = createInMemorySink()
    await runCycle(
      { statePath: join(dir, "state.json") },
      deps({
        sink,
        glob: async () => [main],
        resolveProject: async (startDir) => {
          seenCwds.push(startDir)
          return resolved
        },
      }),
    )

    expect(seenCwds).toEqual(["/work/app"])
    expect(sink.received[0]?.project).toEqual(resolved)
    const payload = sink.received[0]
    expect(payload?.messages.every((m) => m.gitBranch === "main")).toBe(true)
  })

  test("does not flush or advance the watermark when no sessionId is known", async () => {
    const main = join(projects, "no-session.jsonl")
    const sessionlessLine = JSON.stringify({
      uuid: "l1",
      cwd: "/work/app",
      timestamp: "2026-07-23T00:00:00.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
    })
    await writeFile(main, `${sessionlessLine}\n`, "utf8")

    const sink = createInMemorySink()
    const state = await runCycle(config, deps({ sink, glob: async () => [main] }))

    expect(sink.received).toHaveLength(0)
    expect(state.files[main]).toBeUndefined()
  })
})
