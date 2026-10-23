import { expect, test, vi } from "vitest"
import { normalizedMessageSchema } from "../../ingest/types.js"
import { createLogger } from "../../logging.js"
import type { CodexHistory, CodexHistoryReader, CodexReadOptions } from "../codex-history.js"
import { codexThreadSchema } from "../codex-history.js"
import type { CheckpointStore, CollectDeps, SessionTrack } from "../types.js"

const thread = codexThreadSchema.parse({
  id: "root",
  cwd: "/work/app",
  createdAt: 1_790_000_000,
  updatedAt: 1_790_000_100,
  historyMode: "paginated",
  model: "latest-model",
  modelProvider: "openai",
  gitInfo: { sha: "original-commit" },
})
const history: CodexHistory = {
  thread,
  turns: [{ id: "turn", status: "completed", items: [] }],
  items: [
    {
      turnId: "turn",
      item: { id: "prompt", type: "userMessage", content: [{ type: "text", text: "hello" }] },
    },
    {
      turnId: "turn",
      item: {
        id: "shell",
        type: "commandExecution",
        command: "git status",
        cwd: "/work/app/sub",
        status: "completed",
        aggregatedOutput: "clean",
        exitCode: 0,
      },
    },
    { turnId: "turn", item: { id: "answer", type: "agentMessage", text: "done" } },
  ],
}
const deps: CollectDeps = {
  fs: {
    readFile: async () => "",
    writeFile: async () => {},
    rename: async () => {},
    stat: async () => ({ size: 0, mtimeMs: 0 }),
  },
  glob: async () => [],
  resolveProject: async () => ({ name: "app", slug: "acme-app", root: "/work/app" }),
  log: createLogger({ service: "codex-test" }, { level: "silent" }),
}
const readerFor = (value: CodexHistory): CodexHistoryReader => ({
  listThreads: async () => [value.thread],
  readThread: async () => value,
  close: async () => {},
})
const saved = (track: SessionTrack): CheckpointStore => ({
  checkpoints: {
    [track.checkpointKey]: {
      ...track.checkpointAt(track.lastLineProcessed),
      filePath: track.checkpointKey,
      lastUpdatedAt: "2026-10-01T00:00:00Z",
    },
  },
})

const savedTracks = (tracks: ReadonlyArray<SessionTrack>): CheckpointStore => ({
  checkpoints: Object.assign({}, ...tracks.map((track) => saved(track).checkpoints)),
})

const bumped = (value: CodexHistory): CodexHistory => ({
  ...value,
  thread: { ...value.thread, updatedAt: value.thread.updatedAt + 1 },
})

const lines = (track: SessionTrack | undefined) =>
  track?.records.map((record) => [
    record.lineNumber,
    record.messages.map((message) => message.msgType),
  ])

const checkpointOf = (store: CheckpointStore, key = "codex:root") => {
  const checkpoint = store.checkpoints[key]
  if (checkpoint?.source !== "codex") throw new Error(`missing ${key}`)
  return checkpoint
}

test("search and image output wait for native completion instead of acknowledging empty beginnings", async () => {
  const { createCodexPlugin } = await import("./codex.js")
  const initial: CodexHistory = {
    ...history,
    turns: [{ id: "turn", status: "inProgress", items: [] }],
    items: [
      {
        turnId: "turn",
        item: { id: "search", type: "webSearch", query: "", action: null, results: null },
      },
      { turnId: "turn", item: { id: "image", type: "imageGeneration", status: "", result: "" } },
    ],
  }
  const first = (
    await createCodexPlugin({ reader: readerFor(initial) }).collect({ checkpoints: {} }, deps)
  )[0]?.tracks[0]
  if (!first) throw new Error("missing initial metadata")
  expect(
    first.records
      .flatMap((record) => record.messages)
      .filter((message) => message.msgType === "toolResult"),
  ).toEqual([])
  const completed: CodexHistory = {
    ...bumped(history),
    items: [
      {
        turnId: "turn",
        item: { id: "search", type: "webSearch", query: "answer", results: ["found"] },
      },
      {
        turnId: "turn",
        item: { id: "image", type: "imageGeneration", status: "completed", result: "image-data" },
      },
    ],
  }
  const second = (
    await createCodexPlugin({ reader: readerFor(completed) }).collect(saved(first), deps)
  )[0]?.tracks[0]
  const results = second?.records
    .flatMap((record) => record.messages)
    .filter((message) => message.msgType === "toolResult")
  expect(results?.map((message) => message.details.output)).toEqual([
    { id: "search", type: "webSearch", query: "answer", results: ["found"] },
    "image-data",
  ])
})

test("later collaboration preserves the proven spawn link across incremental reads", async () => {
  const { createCodexPlugin } = await import("./codex.js")
  let parent: CodexHistory = {
    ...history,
    items: [
      {
        turnId: "turn",
        item: {
          id: "spawn",
          type: "collabAgentToolCall",
          tool: "spawnAgent",
          status: "completed",
          receiverThreadIds: ["child"],
        },
      },
    ],
  }
  let child: CodexHistory = {
    ...history,
    thread: { ...thread, id: "child", parentThreadId: "root" },
  }
  const plugin = createCodexPlugin({
    reader: {
      listThreads: async () => [parent.thread, child.thread],
      readThread: async (id) => (id === "root" ? parent : child),
      close: async () => {},
    },
  })
  const first = (await plugin.collect({ checkpoints: {} }, deps))[0]
  if (!first) throw new Error("missing family")
  const agent = first.tracks.find((track) => track.type === "subagent")
  parent = {
    ...parent,
    items: [
      {
        turnId: "later",
        item: {
          id: "send",
          type: "collabAgentToolCall",
          tool: "sendInput",
          status: "completed",
          receiverThreadIds: ["child"],
        },
      },
    ],
  }
  child = { ...child, thread: { ...child.thread, updatedAt: child.thread.updatedAt + 1 } }
  const next = (await plugin.collect(savedTracks(first.tracks), deps))[0]?.tracks.find(
    (track) => track.type === "subagent",
  )
  expect(next?.type === "subagent" && next.agent.spawnToolUseId).toBe(
    agent?.type === "subagent" && agent.agent.spawnToolUseId,
  )
})

test("successful project identities are cached while project eligibility is refreshed each cycle", async () => {
  const { createCodexPlugin } = await import("./codex.js")
  const plugin = createCodexPlugin({
    reader: {
      ...readerFor(history),
      listThreads: async () =>
        Array.from({ length: 10 }, (_, index) => ({ ...thread, id: `root-${index}` })),
    },
  })
  let resolves = 0
  let checks = 0
  const callbacks = {
    ...deps,
    resolveProject: async () => {
      resolves++
      return { name: "app", slug: "app" }
    },
    shouldCapture: async () => {
      checks++
      return false
    },
  }
  await plugin.collect({ checkpoints: {} }, callbacks)
  await plugin.collect({ checkpoints: {} }, callbacks)
  expect(resolves).toBe(1)
  expect(checks).toBe(2)
})

test("a changed nested child is read alone and its unchanged ancestors are sent as headers", async () => {
  const { createCodexPlugin } = await import("./codex.js")
  let values: CodexHistory[] = [
    history,
    { ...history, thread: { ...thread, id: "parent", parentThreadId: "root" } },
    { ...history, thread: { ...thread, id: "nested", parentThreadId: "parent" } },
  ]
  const reads: string[] = []
  const plugin = createCodexPlugin({
    reader: {
      listThreads: async () => values.map((value) => value.thread),
      readThread: async (id) => {
        reads.push(id)
        const value = values.find((value) => value.thread.id === id)
        if (!value) throw new Error("missing")
        return value
      },
      close: async () => {},
    },
  })
  const first = (await plugin.collect({ checkpoints: {} }, deps))[0]
  if (!first) throw new Error("missing family")
  reads.length = 0
  values = values.map((value) =>
    value.thread.id !== "nested"
      ? value
      : {
          ...bumped(value),
          turns: [...value.turns, { id: "later", status: "completed", items: [] }],
          items: [
            ...value.items,
            { turnId: "later", item: { id: "new", type: "agentMessage", text: "nested update" } },
          ],
        },
  )
  const next = (await plugin.collect(savedTracks(first.tracks), deps))[0]
  expect(next?.tracks.map((track) => track.checkpointKey)).toEqual([
    "codex:root",
    "codex:parent",
    "codex:nested",
  ])
  expect(next?.tracks.slice(0, 2).map((track) => track.records.length)).toEqual([0, 0])
  expect(reads).toEqual(["nested"])
})

test("an unavailable child does not force full reads of an already captured root", async () => {
  const { createCodexPlugin } = await import("./codex.js")
  const main = (
    await createCodexPlugin({ reader: readerFor(history) }).collect({ checkpoints: {} }, deps)
  )[0]?.tracks[0]
  if (!main) throw new Error("missing root")
  let fullRootReads = 0
  const plugin = createCodexPlugin({
    reader: {
      listThreads: async () => [thread, { ...thread, id: "unavailable", parentThreadId: "root" }],
      readThread: async (id, options) => {
        if (id !== "root") throw new Error("not available")
        if (!options) fullRootReads++
        return history
      },
      close: async () => {},
    },
  })
  await plugin.collect(saved(main), deps)
  await plugin.collect(saved(main), deps)
  expect(fullRootReads).toBe(0)
})

test("structured MCP arguments are redacted in both normalized input and the stored API snapshot", async () => {
  const { createCodexPlugin } = await import("./codex.js")
  const value: CodexHistory = {
    ...history,
    items: [
      {
        turnId: "turn",
        item: {
          id: "mcp",
          type: "mcpToolCall",
          server: "example",
          tool: "lookup",
          status: "completed",
          arguments: JSON.stringify({ api_key: "private-key-value", query: "hello" }),
          result: { content: [] },
        },
      },
    ],
  }
  const batches = await createCodexPlugin({ reader: readerFor(value) }).collect(
    { checkpoints: {} },
    deps,
  )
  expect(JSON.stringify(batches[0]?.tracks[0]?.records)).not.toContain("private-key-value")
  expect(batches[0]?.tracks[0]?.records[0]?.messages[0]).toMatchObject({
    details: { input: { api_key: "[Redacted]", query: "hello" } },
  })
})

test("a finished tool sends only its result at its call's line, and a partial upload keeps the rest pending", async () => {
  const { createCodexPlugin } = await import("./codex.js")
  const running: CodexHistory = {
    ...history,
    turns: [{ id: "turn", status: "inProgress", items: [] }],
    items: history.items.map((entry) =>
      entry.item.id === "shell"
        ? { ...entry, item: { ...entry.item, status: "inProgress" } }
        : entry,
    ),
  }
  const first = (
    await createCodexPlugin({ reader: readerFor(running) }).collect({ checkpoints: {} }, deps)
  )[0]?.tracks[0]
  if (!first) throw new Error("missing first snapshot")
  expect(lines(first)).toEqual([
    [1, ["message"]],
    [2, ["toolCall"]],
  ])
  const finished = bumped({
    ...history,
    items: [
      ...history.items,
      { turnId: "turn", item: { id: "later", type: "agentMessage", text: "new" } },
    ],
  })
  const second = (
    await createCodexPlugin({ reader: readerFor(finished) }).collect(saved(first), deps)
  )[0]?.tracks[0]
  if (!second) throw new Error("missing late completion")
  expect(lines(second)).toEqual([
    [2, ["toolResult"]],
    [3, ["message"]],
    [4, ["message"]],
    [5, ["turnEvent"]],
  ])
  const partial: CheckpointStore = {
    checkpoints: {
      [second.checkpointKey]: {
        ...second.checkpointAt(2),
        filePath: second.checkpointKey,
        lastUpdatedAt: "2026-10-01T00:00:00Z",
      },
    },
  }
  expect(checkpointOf(partial)).toMatchObject({
    updatedAt: thread.updatedAt,
    end: { turnId: "turn", itemId: "answer", ordinal: 3 },
    pending: [{ turnId: "turn", itemId: "answer", ordinal: 3, partial: false }],
  })
  const resumed = (
    await createCodexPlugin({ reader: readerFor(finished) }).collect(partial, deps)
  )[0]?.tracks[0]
  expect(lines(resumed)).toEqual([
    [3, ["message"]],
    [4, ["message"]],
    [5, ["turnEvent"]],
  ])
})

test("a running tool without a terminal status is never sent as a finished result", async () => {
  const { createCodexPlugin } = await import("./codex.js")
  const running: CodexHistory = {
    ...history,
    turns: [{ id: "turn", status: "inProgress", items: [] }],
    items: [
      {
        turnId: "turn",
        item: { id: "mcp", type: "mcpToolCall", server: "example", tool: "lookup" },
      },
      { turnId: "turn", item: { id: "edit", type: "fileChange", status: "running", changes: [] } },
    ],
  }
  const first = (
    await createCodexPlugin({ reader: readerFor(running) }).collect({ checkpoints: {} }, deps)
  )[0]?.tracks[0]
  if (!first) throw new Error("missing running track")
  expect(lines(first)).toEqual([[1, ["toolCall"]]])
  expect(checkpointOf(saved(first)).pending).toEqual([
    { turnId: "turn", itemId: "mcp", ordinal: 1, partial: true },
    { turnId: "turn", itemId: "edit", ordinal: 2, partial: false },
  ])
  const done = bumped({
    ...running,
    items: [
      {
        turnId: "turn",
        item: {
          id: "mcp",
          type: "mcpToolCall",
          server: "example",
          tool: "lookup",
          status: "completed",
          result: { content: [] },
        },
      },
      {
        turnId: "turn",
        item: { id: "edit", type: "fileChange", status: "completed", changes: [] },
      },
    ],
  })
  const second = (
    await createCodexPlugin({ reader: readerFor(done) }).collect(saved(first), deps)
  )[0]?.tracks[0]
  if (!second) throw new Error("missing finished track")
  expect(lines(second)).toEqual([
    [1, ["toolResult"]],
    [2, ["toolCall", "toolResult"]],
  ])
  expect(second.records[0]?.messages[0]).toMatchObject({ details: { status: "success" } })
  const checkpoint = checkpointOf(saved(second))
  expect(checkpoint).toMatchObject({
    updatedAt: done.thread.updatedAt,
    end: { turnId: "turn", itemId: "edit", ordinal: 2 },
    pending: [],
  })
  expect(checkpoint).not.toHaveProperty("items")
})

test("an unchanged thread is not read again and a changed one is read from its first unfinished turn", async () => {
  const { createCodexPlugin } = await import("./codex.js")
  let value: CodexHistory = {
    ...history,
    turns: [
      { id: "old", status: "completed", items: [] },
      { id: "turn", status: "inProgress", items: [] },
    ],
    items: [
      {
        turnId: "old",
        item: { id: "first", type: "userMessage", content: [{ type: "text", text: "hi" }] },
      },
      { turnId: "turn", item: { id: "answer", type: "agentMessage", text: "streaming" } },
    ],
  }
  const reads: Array<CodexReadOptions | undefined> = []
  const plugin = createCodexPlugin({
    reader: {
      listThreads: async () => [value.thread],
      readThread: async (_id, options) => {
        reads.push(options)
        return value
      },
      close: async () => {},
    },
  })
  const first = (await plugin.collect({ checkpoints: {} }, deps))[0]?.tracks[0]
  if (!first) throw new Error("missing first read")
  expect(await plugin.collect(saved(first), deps)).toEqual([])
  value = bumped({
    ...value,
    turns: [
      { id: "old", status: "completed", items: [] },
      { id: "turn", status: "completed", items: [] },
    ],
  })
  const second = (await plugin.collect(saved(first), deps))[0]?.tracks[0]
  expect(reads).toEqual([undefined, { fromTurnId: "turn" }])
  expect(lines(second)).toEqual([
    [3, ["message"]],
    [4, ["turnEvent"]],
  ])
})

test("a new child under an unchanged root still links to its spawn call", async () => {
  const { createCodexPlugin } = await import("./codex.js")
  const parent: CodexHistory = {
    ...history,
    items: [
      {
        turnId: "turn",
        item: {
          id: "spawn",
          type: "collabAgentToolCall",
          tool: "spawnAgent",
          status: "completed",
          receiverThreadIds: ["child"],
        },
      },
    ],
  }
  const child: CodexHistory = {
    ...history,
    thread: { ...thread, id: "child", parentThreadId: "root" },
  }
  let values = [parent]
  const plugin = createCodexPlugin({
    reader: {
      listThreads: async () => values.map((value) => value.thread),
      readThread: async (id) => (id === "root" ? parent : child),
      close: async () => {},
    },
  })
  const first = (await plugin.collect({ checkpoints: {} }, deps))[0]
  if (!first) throw new Error("missing root")
  values = [parent, child]
  const next = (await plugin.collect(savedTracks(first.tracks), deps))[0]
  const main = next?.tracks.find((track) => track.type === "main")
  const agent = next?.tracks.find((track) => track.type === "subagent")
  expect(main?.records).toEqual([])
  expect(agent?.type === "subagent" && agent.agent.spawnToolUseId).toMatch(/^codex:/)
})

test("a rollback drops pending items, and a vanished end turn is read in full after the old end", async () => {
  const { createCodexPlugin } = await import("./codex.js")
  let value: CodexHistory = {
    ...history,
    turns: [
      { id: "a", status: "completed", items: [] },
      { id: "b", status: "inProgress", items: [] },
    ],
    items: [
      { turnId: "a", item: { id: "prompt", type: "userMessage", content: [] } },
      { turnId: "b", item: { id: "draft", type: "agentMessage", text: "half" } },
    ],
  }
  const reads: Array<CodexReadOptions | undefined> = []
  const log = createLogger({ service: "codex-test" }, { level: "silent" })
  const warn = vi.spyOn(log, "warn")
  const plugin = createCodexPlugin({
    reader: {
      listThreads: async () => [value.thread],
      readThread: async (_id, options) => {
        reads.push(options)
        return value
      },
      close: async () => {},
    },
  })
  const first = (await plugin.collect({ checkpoints: {} }, { ...deps, log }))[0]?.tracks[0]
  if (!first) throw new Error("missing first read")
  expect(checkpointOf(saved(first))).toMatchObject({
    end: { turnId: "b", itemId: "draft", ordinal: 3 },
    pending: [{ itemId: "draft", ordinal: 3 }],
  })
  value = bumped({
    ...value,
    turns: [
      { id: "a", status: "completed", items: [] },
      { id: "c", status: "completed", items: [] },
    ],
    items: [
      { turnId: "a", item: { id: "prompt", type: "userMessage", content: [] } },
      { turnId: "c", item: { id: "retry", type: "agentMessage", text: "again" } },
    ],
  })
  const second = (await plugin.collect(saved(first), { ...deps, log }))[0]?.tracks[0]
  if (!second) throw new Error("missing rollback read")
  expect(reads.slice(1)).toEqual([{ fromTurnId: "b" }, undefined])
  expect(warn).toHaveBeenCalledWith(
    expect.objectContaining({ threadId: "root" }),
    expect.stringContaining("full"),
  )
  expect(second.records.map((record) => record.lineNumber)).toEqual([5, 6, 7])
  expect(checkpointOf(saved(second))).toMatchObject({
    end: { turnId: "c", itemId: "turn:c", ordinal: 7 },
    pending: [],
  })
})

test("a thread updated in the same second it was listed keeps its old update time", async () => {
  const { createCodexPlugin } = await import("./codex.js")
  let reads = 0
  let now = thread.updatedAt * 1000 + 500
  const plugin = createCodexPlugin({
    reader: {
      ...readerFor(history),
      readThread: async () => {
        reads++
        return history
      },
    },
    now: () => now,
  })
  const first = (await plugin.collect({ checkpoints: {} }, deps))[0]?.tracks[0]
  if (!first) throw new Error("missing first read")
  expect(checkpointOf(saved(first)).updatedAt).toBe(0)
  now += 1000
  const second = (await plugin.collect(saved(first), deps))[0]?.tracks[0]
  if (!second) throw new Error("missing settled read")
  expect(second.records).toEqual([])
  expect(checkpointOf(saved(second)).updatedAt).toBe(thread.updatedAt)
  expect(await plugin.collect(saved(second), deps)).toEqual([])
  expect(reads).toBe(2)
})

test("disabled projects and sessions before the root cutoff do not load full histories", async () => {
  const { createCodexPlugin } = await import("./codex.js")
  let reads = 0
  const reader: CodexHistoryReader = {
    ...readerFor(history),
    readThread: async () => {
      reads++
      return history
    },
  }
  const plugin = createCodexPlugin({ reader })
  expect(
    await plugin.collect({ checkpoints: {} }, { ...deps, shouldCapture: async () => false }),
  ).toEqual([])
  expect(
    await plugin.collect(
      { checkpoints: {} },
      { ...deps, syncFromFor: async () => "2030-01-01T00:00:00Z" },
    ),
  ).toEqual([])
  expect(reads).toBe(0)
})

test("streaming assistant text waits for completion and turn boundaries keep conversation order", async () => {
  const { createCodexPlugin } = await import("./codex.js")
  const active: CodexHistory = {
    ...history,
    turns: [{ id: "turn", status: "inProgress", items: [] }],
  }
  const first = (
    await createCodexPlugin({ reader: readerFor(active) }).collect({ checkpoints: {} }, deps)
  )[0]?.tracks[0]
  if (!first) throw new Error("missing active track")
  expect(
    first.records
      .flatMap((record) => record.messages)
      .filter((message) => message.msgType === "message" && message.role === "assistant"),
  ).toEqual([])
  const complete = (
    await createCodexPlugin({ reader: readerFor(bumped(history)) }).collect(saved(first), deps)
  )[0]?.tracks[0]
  expect(complete?.records.flatMap((record) => record.messages)).toMatchObject([
    { msgType: "message", content: { value: "done" } },
    { msgType: "turnEvent" },
  ])
})

test("nested native children share the root while forks stay independent", async () => {
  const { createCodexPlugin } = await import("./codex.js")
  const child: CodexHistory = {
    ...history,
    thread: { ...thread, id: "child", parentThreadId: "root" },
  }
  const nested: CodexHistory = {
    ...history,
    thread: { ...thread, id: "nested", parentThreadId: "child" },
  }
  const fork: CodexHistory = { ...history, thread: { ...thread, id: "fork", forkedFromId: "root" } }
  const values = [history, child, nested, fork]
  const reader: CodexHistoryReader = {
    listThreads: async () => values.map((value) => value.thread),
    readThread: async (id) => {
      const value = values.find((value) => value.thread.id === id)
      if (!value) throw new Error("unknown thread")
      return value
    },
    close: async () => {},
  }
  const batches = await createCodexPlugin({ reader }).collect({ checkpoints: {} }, deps)
  expect(batches.map((batch) => batch.sessionId)).toEqual(["root", "fork"])
  expect(batches[0]?.tracks[2]).toMatchObject({
    type: "subagent",
    sessionId: "root",
    agent: { agentId: "nested", parentAgentId: "child" },
  })
  const ids = batches.flatMap((batch) =>
    batch.tracks.flatMap((track) => track.records.map((record) => record.lineUuid)),
  )
  expect(new Set(ids).size).toBe(ids.length)
})

test("Codex capture preserves conversation, canonical shell links, and native origin without invented telemetry", async () => {
  const module = await import("./codex.js").catch(() => null)
  expect(module).not.toBeNull()
  if (!module) return
  const plugin = module.createCodexPlugin({ reader: readerFor(history) })
  const batches = await plugin.collect({ checkpoints: {} }, deps)
  const main = batches[0]?.tracks[0]
  expect(main).toMatchObject({
    source: "codex",
    type: "main",
    startCommit: "original-commit",
    startCwd: "/work/app",
  })
  if (!main) throw new Error("missing main track")
  const messages = main.records.flatMap((record) => record.messages)
  expect(messages.every((message) => normalizedMessageSchema.safeParse(message).success)).toBe(true)
  expect(
    messages.filter((message) => message.msgType === "message").map((message) => message.content),
  ).toEqual([
    { type: "text", value: "hello" },
    { type: "text", value: "done" },
  ])
  const call = messages.find((message) => message.msgType === "toolCall")
  const result = messages.find((message) => message.msgType === "toolResult")
  expect(call).toMatchObject({
    cwd: "/work/app/sub",
    details: { metadata: { type: "shell", command: "git status" } },
  })
  expect(call?.msgType === "toolCall" && call.details.callId).toBe(
    result?.msgType === "toolResult" && result.details.callId,
  )
  expect(
    messages.every((message) => message.model === undefined && message.timestamp === undefined),
  ).toBe(true)
  expect(await plugin.collect(saved(main), deps)).toEqual([])
})
