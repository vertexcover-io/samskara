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

const record = (lineNumber: number, messages: number): ParsedRecord => ({
  lineUuid: `u${lineNumber}`,
  lineNumber,
  raw: "{}",
  messages: Array.from({ length: messages }, (_, i) => ({
    subIndex: i,
    sessionId: "s",
    source: "claude_code",
    sourceSchemaVersion: 1,
    msgType: "assistant",
    timestamp: "2026-07-23T00:00:00.000Z",
  })),
})

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

  test("a record straddling the cap advances only to the last complete line", () => {
    // line 1 has 3 messages, cap 2 → line 1 splits across two chunks.
    const chunks = sliceByMessages([record(1, 3), record(2, 1)], 2)
    // chunk 0: 2 msgs of line 1 → no complete line yet (lastComplete 0)
    expect(chunks[0]?.lastCompleteLine).toBe(0)
    expect(chunks[0]?.records[0]?.lineUuid).toBe("u1")
    // chunk 1: remaining 1 msg of line 1 completes it, then line 2
    expect(chunks[1]?.lastCompleteLine).toBe(2)
    // both chunks carry the same lineUuid for line 1
    expect(chunks[1]?.records[0]?.lineUuid).toBe("u1")
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
    projects = join(dir, "projects")
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
    expect(store.checkpoints[main]?.projectSlug).toBe("acme-widget")
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
    expect(sink3.received[0]?.records.every((r) => r.lineUuid === "l2")).toBe(true)
  })

  test("REQ-031,EDGE-014: legacy checkpoint resumes and gains projectSlug after flush", async () => {
    const main = join(projects, "legacy.jsonl")
    await writeFile(main, `${assistantLine("l1", "sess-legacy")}\n`, "utf8")
    const initial = await stat(main)
    await writeFile(
      config.statePath,
      JSON.stringify({
        checkpoints: {
          [main]: {
            filePath: main,
            lastUpdatedAt: "2026-07-25T09:00:00.000Z",
            source: "claude_code",
            mtime: initial.mtimeMs,
            size: initial.size,
            lineProcessed: 1,
          },
        },
      }),
      "utf8",
    )
    await writeFile(
      main,
      `${assistantLine("l1", "sess-legacy")}\n${assistantLine("l2", "sess-legacy")}\n`,
      "utf8",
    )
    const sink = createInMemorySink()

    const store = await runCycle(config, deps({ sink, glob: async () => [main] }))

    expect(sink.received).toHaveLength(1)
    expect(sink.received[0]?.records.map((entry) => entry.lineUuid)).toEqual(["l2"])
    expect(store.checkpoints[main]?.projectSlug).toBe("acme-widget")
  })

  test("does not advance the watermark on a 409 and retries next cycle", async () => {
    const sub = join(projects, "subagents", "agent-af66.jsonl")
    await mkdir(join(projects, "subagents"), { recursive: true })
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
    const sub = join(projects, "subagents", "agent-af66.jsonl")
    await mkdir(join(projects, "subagents"), { recursive: true })
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
    expect(sink.received[0]?.records.every((r) => r.lineUuid === "l1")).toBe(true)
    expect(store.checkpoints[main]?.lineProcessed).toBe(1)

    await writeFile(
      main,
      `${assistantLine("l1", "sess-1")}\n${assistantLine("l2", "sess-1")}\n`,
      "utf8",
    )
    const sink2 = createInMemorySink()
    await runCycle(config, deps({ sink: sink2, glob: async () => [main] }))
    expect(sink2.received[0]?.records.every((r) => r.lineUuid === "l2")).toBe(true)
  })

  test("caps a large scan into multiple chunks and reaches the final line", async () => {
    const main = join(projects, "big.jsonl")
    // Each line fans out into 2 messages; 1500 lines → 3000 messages → ≥2 chunks at cap 2000.
    const lines = Array.from({ length: 1500 }, (_, i) => assistantLine(`l${i + 1}`, "sess-1"))
    await writeFile(main, `${lines.join("\n")}\n`, "utf8")

    const sink = createInMemorySink()
    const store = await runCycle(config, deps({ sink, glob: async () => [main] }))
    expect(sink.received.length).toBeGreaterThanOrEqual(2)
    expect(store.checkpoints[main]?.lineProcessed).toBe(1500)
    expect(MESSAGE_CAP).toBe(2000)
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

  test("REQ-027: skips tracks whose project is not enabled", async () => {
    const main = join(projects, "sess-disabled.jsonl")
    await writeFile(main, `${assistantLine("l1", "sess-disabled")}\n`, "utf8")
    const sink = createInMemorySink()

    const store = await runCycle(
      config,
      deps({ sink, glob: async () => [main], shouldCapture: async () => false }),
    )

    expect(sink.received).toHaveLength(0)
    expect(store.checkpoints[main]).toBeUndefined()
  })

  test("REQ-028,EDGE-012: evaluates project enablement again on every cycle", async () => {
    const main = join(projects, "sess-toggle.jsonl")
    await writeFile(main, `${assistantLine("l1", "sess-toggle")}\n`, "utf8")
    const sink = createInMemorySink()
    let enabled = false
    const cycleDeps = deps({
      sink,
      glob: async () => [main],
      shouldCapture: async () => enabled,
    })

    await runCycle(config, cycleDeps)
    enabled = true
    const store = await runCycle(config, cycleDeps)

    expect(sink.received).toHaveLength(1)
    expect(store.checkpoints[main]?.projectSlug).toBe("acme-widget")
  })

  test("does not flush or advance when no sessionId is known", async () => {
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

    expect(sink.received).toHaveLength(0)
    expect(store.checkpoints[main]).toBeUndefined()
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

    // chunk 1 (mid-line-1) → 200, chunk 2 (rest of line 1 + line 2) → 500.
    let call = 0
    const sink = createInMemorySink(() => (++call === 1 ? 200 : 500))
    const store = await runCycle(config, deps({ sink, glob: async () => [], plugin: stubPlugin }))

    expect(sink.received.length).toBe(2)
    expect(store.checkpoints[key]).toBeUndefined()
  })
})
