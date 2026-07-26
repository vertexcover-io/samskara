import { mkdir, mkdtemp, readFile, rename, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type FileSystem,
  type ParsedRecord,
  type ProjectIdentity,
  createClaudePlugin,
  createLogger,
} from "@samskara/core"
import { beforeEach, describe, expect, test } from "vitest"
import {
  MESSAGE_CAP,
  type WatcherConfig,
  type WatcherDeps,
  runCycle,
  sliceByMessages,
} from "./driver.js"
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

const record = (lineNumber: number, messageCount: number): ParsedRecord => {
  const messages = Array.from({ length: messageCount }, (_, subIndex) => ({
    subIndex,
    sessionId: "s",
    source: "claude_code" as const,
    sourceSchemaVersion: 1,
    trackId: "main",
    msgType: "custom" as const,
    subType: "fixture",
  }))
  const [first, ...rest] = messages
  if (!first) throw new Error("record fixtures require at least one message")
  return {
    lineUuid: `00000000-0000-5000-8000-${lineNumber.toString().padStart(12, "0")}`,
    lineNumber,
    raw: {},
    messages: [first, ...rest],
  }
}

describe("sliceByMessages", () => {
  test("keeps everything in one chunk under the cap", () => {
    const chunks = sliceByMessages([record(1, 2), record(2, 3)], 10)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]?.lastCompleteLine).toBe(2)
    expect(chunks[0]?.records.flatMap((r) => r.messages)).toHaveLength(5)
  })

  test("splits on the cap at a line boundary", () => {
    const chunks = sliceByMessages([record(1, 2), record(2, 2), record(3, 2)], 4)
    expect(chunks).toHaveLength(2)
    expect(chunks[0]?.lastCompleteLine).toBe(2)
    expect(chunks[1]?.lastCompleteLine).toBe(3)
  })

  test("S6: a 1,999-message record plus two-message record and one oversize record remain line atomic", () => {
    const boundaryChunks = sliceByMessages([record(1, 1999), record(2, 2)], MESSAGE_CAP)
    expect(
      boundaryChunks.map((chunk) => chunk.records.flatMap((item) => item.messages).length),
    ).toEqual([1999, 2])
    expect(boundaryChunks.flatMap((chunk) => chunk.records).map((item) => item.lineNumber)).toEqual(
      [1, 2],
    )

    const oversizeChunks = sliceByMessages([record(3, 2500)], MESSAGE_CAP)
    expect(oversizeChunks).toHaveLength(1)
    expect(oversizeChunks[0]?.records[0]?.messages).toHaveLength(2500)
    expect(oversizeChunks[0]?.lastCompleteLine).toBe(3)
  })
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
    log: createLogger({ service: "samskara-cli-test" }, { level: "silent" }),
    ...over,
  })

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "samskara-watch-"))
    projects = join(dir, ".claude", "projects", "bucket")
    await mkdir(projects, { recursive: true })
    config = { statePath: join(dir, "state.json") }
  })

  test("flushes a grown main file and advances the watermark", async () => {
    const main = join(projects, "sess-1.jsonl")
    await writeFile(main, `${assistantLine("l1", "sess-1")}\n`, "utf8")

    const sink = createInMemorySink()
    const store = await runCycle(config, deps({ sink, glob: async () => [main] }))

    expect(sink.received).toHaveLength(1)
    expect(sink.received[0]?.type).toBe("main")
    expect(sink.received[0]?.records).toHaveLength(1)
    expect(sink.received[0]?.records[0]?.messages).toHaveLength(2)
    expect(store.checkpoints[main]?.lineProcessed).toBe(1)
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
    expect(sink3.received[0]?.records.map((item) => item.lineNumber)).toEqual([2])
  })

  test("does not advance the watermark on a 409 and retries next cycle", async () => {
    const sub = join(projects, "sess-1", "subagents", "agent-af66.jsonl")
    await mkdir(join(projects, "sess-1", "subagents"), { recursive: true })
    await writeFile(sub, `${assistantLine("s1", "sess-1", { agentId: "af66" })}\n`, "utf8")
    await writeFile(
      sub.replace(/\.jsonl$/, ".meta.json"),
      JSON.stringify({ agentId: "af66" }),
      "utf8",
    )

    const rejecting = createInMemorySink(() => 409)
    const store = await runCycle(config, deps({ sink: rejecting, glob: async () => [sub] }))
    expect(store.checkpoints[sub]).toBeUndefined()

    const accepting = createInMemorySink(() => 200)
    const next = await runCycle(config, deps({ sink: accepting, glob: async () => [sub] }))
    expect(accepting.received).toHaveLength(1)
    expect(next.checkpoints[sub]?.lineProcessed).toBe(1)
  })

  test("processes main before subagent within a session", async () => {
    const main = join(projects, "sess-1.jsonl")
    const sub = join(projects, "sess-1", "subagents", "agent-af66.jsonl")
    await mkdir(join(projects, "sess-1", "subagents"), { recursive: true })
    await writeFile(main, `${assistantLine("l1", "sess-1")}\n`, "utf8")
    await writeFile(sub, `${assistantLine("s1", "sess-1", { agentId: "af66" })}\n`, "utf8")
    await writeFile(
      sub.replace(/\.jsonl$/, ".meta.json"),
      JSON.stringify({ agentId: "af66" }),
      "utf8",
    )

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
    const store = await runCycle(config, deps({ sink, glob: async () => [main] }))
    expect(sink.received[0]?.records.map((item) => item.lineNumber)).toEqual([1])
    expect(store.checkpoints[main]?.lineProcessed).toBe(1)

    await writeFile(
      main,
      `${assistantLine("l1", "sess-1")}\n${assistantLine("l2", "sess-1")}\n`,
      "utf8",
    )
    const sink2 = createInMemorySink()
    await runCycle(config, deps({ sink: sink2, glob: async () => [main] }))
    expect(sink2.received[0]?.records.map((item) => item.lineNumber)).toEqual([2])
  })

  test("caps a large scan into multiple chunks and reaches the final line", async () => {
    const main = join(projects, "sess-1.jsonl")
    // Each line fans out into 2 messages; 1500 lines → 3000 messages → ≥2 chunks at cap 2000.
    const lines = Array.from({ length: 1500 }, (_, i) => assistantLine(`l${i + 1}`, "sess-1"))
    await writeFile(main, `${lines.join("\n")}\n`, "utf8")

    const sink = createInMemorySink()
    const store = await runCycle(config, deps({ sink, glob: async () => [main] }))
    expect(sink.received.length).toBeGreaterThanOrEqual(2)
    expect(store.checkpoints[main]?.lineProcessed).toBe(1500)
  })

  test("resolves the project from the session cwd and stamps per-message git facts", async () => {
    const main = join(projects, "sess-1.jsonl")
    await writeFile(main, `${assistantLine("l1", "sess-1")}\n`, "utf8")

    const resolved: ProjectIdentity = { name: "andromeda", slug: "refrens-andromeda" }
    const seenCwds: string[] = []
    const sink = createInMemorySink()
    await runCycle(
      config,
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
    const msgs = sink.received[0]?.records.flatMap((r) => r.messages) ?? []
    expect(msgs.every((m) => m.gitBranch === "main")).toBe(true)
  })

  test("derives a missing source sessionId from the transcript path", async () => {
    const main = join(projects, "no-session.jsonl")
    const sessionlessLine = JSON.stringify({
      uuid: "l1",
      cwd: "/work/app",
      timestamp: "2026-07-23T00:00:00.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
    })
    await writeFile(main, `${sessionlessLine}\n`, "utf8")

    const sink = createInMemorySink()
    const store = await runCycle(config, deps({ sink, glob: async () => [main] }))

    expect(sink.received).toHaveLength(1)
    expect(sink.received[0]?.sessionId).toBe("no-session")
    expect(store.checkpoints[main]?.lineProcessed).toBe(1)
  })

  test("independent sessions run in parallel; one failing does not block the other", async () => {
    const a = join(projects, "sess-a.jsonl")
    const b = join(projects, "sess-b.jsonl")
    await writeFile(a, `${assistantLine("a1", "sess-a")}\n`, "utf8")
    await writeFile(b, `${assistantLine("b1", "sess-b")}\n`, "utf8")

    const sink = createInMemorySink((p) => (p.sessionId === "sess-a" ? 500 : 200))
    const store = await runCycle(config, deps({ sink, glob: async () => [a, b] }))

    expect(store.checkpoints[a]).toBeUndefined()
    expect(store.checkpoints[b]?.lineProcessed).toBe(1)
  })

  // A single high-fanout line whose first chunk sends but whose next chunk fails must NOT record a
  // checkpoint, so the plugin re-reads it next cycle (advancing on a mid-line success would freeze
  // the file's mtime/size and skip it forever).
  test("a straddling first chunk that succeeds then fails advances nothing", async () => {
    const key = "/fake/huge.jsonl"
    const track = {
      type: "main" as const,
      sessionId: "sess-huge",
      project,
      sourceRelativePath: key,
      checkpointKey: key,
      records: [record(1, MESSAGE_CAP + 5), record(2, 1)],
      lastLineProcessed: 2,
      checkpointAt: (lineNumber: number) => ({
        source: "claude_code" as const,
        mtime: 10,
        size: 20,
        lineProcessed: lineNumber,
      }),
    }
    const stubPlugin = {
      source: "claude_code",
      collect: async () => [{ sessionId: "sess-huge", tracks: [track] }],
    }

    let call = 0
    const sink = createInMemorySink(() => (++call === 1 ? 500 : 200))
    const store = await runCycle(config, deps({ sink, glob: async () => [], plugin: stubPlugin }))

    expect(sink.received.length).toBe(1)
    expect(store.checkpoints[key]).toBeUndefined()
  })
})
