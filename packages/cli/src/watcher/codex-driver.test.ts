import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { codexThreadSchema, createCodexPlugin, createLogger, type FileSystem } from "@samskara/core"
import { expect, test } from "vitest"
import { runCycle } from "./driver.js"
import { nodeFs } from "./index.js"
import { createInMemorySink } from "./sink.js"

test("a rejected child blocks its descendants while healthy siblings still sync", async () => {
  const dir = await mkdtemp(join(tmpdir(), "samskara-codex-siblings-"))
  const threads = [
    codexThreadSchema.parse({ id: "root", cwd: "/project", createdAt: 1, updatedAt: 2 }),
    ...[
      { id: "bad", parentThreadId: "root" },
      { id: "nested", parentThreadId: "bad" },
      { id: "healthy", parentThreadId: "root" },
    ].map((value) =>
      codexThreadSchema.parse({ cwd: "/project", createdAt: 1, updatedAt: 2, ...value }),
    ),
  ]
  const plugin = createCodexPlugin({
    reader: {
      listThreads: async () => threads,
      readThread: async (id) => {
        const thread = threads.find((thread) => thread.id === id)
        if (!thread) throw new Error("missing")
        return { thread, turns: [], items: [] }
      },
      close: async () => {},
    },
  })
  const sink = createInMemorySink((payload) =>
    payload.type === "subagent" && payload.agent.agentId === "bad" ? 413 : 200,
  )
  try {
    await runCycle(
      { statePath: join(dir, "state.json"), messageCap: 1, sessionConcurrency: 1 },
      {
        fs: nodeFs,
        clock: { now: () => 1000 },
        sink,
        glob: async () => [],
        plugins: [plugin],
        resolveProject: async () => ({ name: "app", slug: "app" }),
        log: createLogger({ service: "test" }, { level: "silent" }),
      },
    )
    expect(
      sink.received.map((payload) => (payload.type === "main" ? "root" : payload.agent.agentId)),
    ).toEqual(["root", "bad", "healthy"])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("a metadata-only Codex session retries failed uploads, then checkpoints its native origin once", async () => {
  const files = new Map<string, string>()
  const fs: FileSystem = {
    readFile: async (path) => {
      const value = files.get(path)
      if (value === undefined) throw new Error("missing")
      return value
    },
    writeFile: async (path, value) => {
      files.set(path, value)
    },
    rename: async (from, to) => {
      const value = files.get(from)
      if (value !== undefined) files.set(to, value)
      files.delete(from)
    },
    stat: async () => ({ size: 0, mtimeMs: 0 }),
  }
  const thread = codexThreadSchema.parse({
    id: "native",
    cwd: "/missing/project",
    createdAt: 100,
    updatedAt: 200,
    gitInfo: { sha: "native-commit" },
  })
  const plugin = createCodexPlugin({
    reader: {
      listThreads: async () => [thread],
      readThread: async () => ({ thread, turns: [], items: [] }),
      close: async () => {},
    },
  })
  let status = 503
  const sink = createInMemorySink(() => status)
  const config = { statePath: "/state", messageCap: 1, sessionConcurrency: 1 }
  const deps = {
    fs,
    clock: { now: () => 1000 },
    sink,
    glob: async () => [],
    plugins: [plugin],
    resolveProject: async () => ({ name: "app", slug: "app" }),
    log: createLogger({ service: "driver-test" }, { level: "silent" }),
  }
  const failed = await runCycle(config, deps)
  expect(sink.received).toHaveLength(1)
  expect(failed.checkpoints).toEqual({})
  status = 200
  const saved = await runCycle(config, deps)
  expect(sink.received[1]).toMatchObject({
    type: "main",
    records: [],
    startCwd: "/missing/project",
    startCommit: "native-commit",
    sourceContext: { startedAt: "1970-01-01T00:01:40.000Z" },
  })
  expect(saved.checkpoints["codex:native"]).toMatchObject({ source: "codex", sessionId: "native" })
  await runCycle(config, deps)
  expect(sink.received).toHaveLength(2)
})

test("a partial Codex upload re-reads the thread next cycle and sends only what was left", async () => {
  const dir = await mkdtemp(join(tmpdir(), "samskara-codex-partial-"))
  const thread = codexThreadSchema.parse({
    id: "root",
    cwd: "/project",
    createdAt: 100,
    updatedAt: 200,
    historyMode: "paginated",
  })
  let reads = 0
  const plugin = createCodexPlugin({
    reader: {
      listThreads: async () => [thread],
      readThread: async () => {
        reads++
        return {
          thread,
          turns: [{ id: "turn", status: "completed", items: [] }],
          items: ["a", "b", "c"].map((id) => ({
            turnId: "turn",
            item: { id, type: "agentMessage", text: id },
          })),
        }
      },
      close: async () => {},
    },
  })
  let sends = 0
  const sink = createInMemorySink(() => (++sends === 3 ? 503 : 200))
  const config = { statePath: join(dir, "state.json"), messageCap: 1, sessionConcurrency: 1 }
  const deps = {
    fs: nodeFs,
    clock: { now: () => 1000 },
    sink,
    glob: async () => [],
    plugins: [plugin],
    resolveProject: async () => ({ name: "app", slug: "app" }),
    log: createLogger({ service: "test" }, { level: "silent" }),
  }
  try {
    const partial = await runCycle(config, deps)
    expect(partial.checkpoints["codex:root"]).toMatchObject({
      updatedAt: 0,
      end: { itemId: "b", ordinal: 2 },
    })
    const done = await runCycle(config, deps)
    expect(done.checkpoints["codex:root"]).toMatchObject({
      updatedAt: 200,
      end: { itemId: "turn:turn", ordinal: 4 },
      pending: [],
    })
    await runCycle(config, deps)
    expect(
      sink.received.map((payload) => payload.records.map((record) => record.lineNumber)),
    ).toEqual([[1], [2], [3], [3], [4]])
    expect(reads).toBe(2)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
