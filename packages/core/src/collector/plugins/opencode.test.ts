import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import BetterSqlite3 from "better-sqlite3"
import { describe, expect, test } from "vitest"
import { normalizedMessageSchema } from "../../ingest/types.js"
import { createLogger } from "../../logging.js"
import type { CheckpointStore, CollectDeps } from "../types.js"
import {
  createOpencodePlugin,
  defaultDbPath,
  normalizeOpencode,
  type OpencodeDatabase,
  openDatabase,
} from "./opencode.js"

const log = createLogger({ service: "opencode-test" }, { level: "silent" })
const project = { name: "samskara", slug: "vertexcover-io-samskara" } as const
const empty: CheckpointStore = { checkpoints: {} }

const opencodeSchema = `
CREATE TABLE session (
  id TEXT PRIMARY KEY,
  parent_id TEXT,
  slug TEXT NOT NULL,
  directory TEXT NOT NULL,
  title TEXT NOT NULL,
  version TEXT NOT NULL DEFAULT '0',
  time_created INTEGER NOT NULL,
  time_updated INTEGER NOT NULL,
  agent TEXT,
  model TEXT
);
CREATE TABLE message (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  time_created INTEGER NOT NULL,
  time_updated INTEGER NOT NULL,
  data TEXT NOT NULL
);
CREATE TABLE part (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  time_created INTEGER NOT NULL,
  time_updated INTEGER NOT NULL,
  data TEXT NOT NULL
);
`

const newDatabase = (path = ":memory:"): BetterSqlite3.Database => {
  const db = new BetterSqlite3(path)
  db.exec(opencodeSchema)
  return db
}

const wrap = (db: BetterSqlite3.Database): OpencodeDatabase => ({
  dbPath: ":memory:",
  prepare: (sql) => ({
    all: (...params) => db.prepare(sql).all(...params) as ReadonlyArray<Record<string, unknown>>,
  }),
  close: () => db.close(),
})

type SessionRow = {
  readonly id: string
  readonly parentId?: string
  readonly directory?: string
  readonly title?: string
  readonly timeCreated?: number
  readonly timeUpdated?: number
  readonly agent?: string
}

const insertSession = (db: BetterSqlite3.Database, row: SessionRow): void => {
  db.prepare(
    `INSERT INTO session (id, parent_id, slug, directory, title, time_created, time_updated, agent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.parentId ?? null,
    row.id,
    row.directory ?? "/work/app",
    row.title ?? "Build the thing",
    row.timeCreated ?? 1_000,
    row.timeUpdated ?? 1_000,
    row.agent ?? "build",
  )
}

type ContentRow = {
  readonly id: string
  readonly sessionId: string
  readonly timeCreated?: number
  readonly data: Record<string, unknown>
}

const insertMessage = (db: BetterSqlite3.Database, row: ContentRow): void => {
  const at = row.timeCreated ?? 1_000
  db.prepare(
    "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
  ).run(row.id, row.sessionId, at, at, JSON.stringify(row.data))
}

const insertPart = (
  db: BetterSqlite3.Database,
  row: ContentRow & { readonly messageId: string },
): void => {
  const at = row.timeCreated ?? 1_000
  db.prepare(
    "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(row.id, row.messageId, row.sessionId, at, at, JSON.stringify(row.data))
}

const userTurn = (db: BetterSqlite3.Database, sessionId: string, at = 1_000): void => {
  insertMessage(db, {
    id: `msg_${sessionId}_u`,
    sessionId,
    timeCreated: at,
    data: { role: "user", path: { cwd: "/work/app" } },
  })
  insertPart(db, {
    id: `part_${sessionId}_u`,
    messageId: `msg_${sessionId}_u`,
    sessionId,
    timeCreated: at,
    data: { type: "text", text: "go" },
  })
}

const collectDeps = (over: Partial<CollectDeps> = {}): CollectDeps => ({
  fs: {} as CollectDeps["fs"],
  glob: async () => [],
  resolveProject: async () => project,
  log,
  ...over,
})

const opencodeCheckpoint = (sessionId: string, timeUpdated: number) => ({
  [`opencode:${sessionId}`]: {
    source: "opencode" as const,
    filePath: `opencode:${sessionId}`,
    lastUpdatedAt: "2026-08-01T00:00:00.000Z",
    timeUpdated,
    lastMessageId: "msg_any",
  },
})

describe("normalizeOpencode", () => {
  const ctx = { sessionId: "ses_1", trackId: "main" }
  const assistant = (id: string, at: number, extra: Record<string, unknown> = {}) => ({
    id,
    timeCreated: at,
    data: { role: "assistant", path: { cwd: "/work/app" }, ...extra },
  })
  const part = (id: string, at: number, data: Record<string, unknown>) => ({
    id,
    timeCreated: at,
    data,
  })

  test("a user message with a text part becomes one user text message at subIndex 0", () => {
    const messages = normalizeOpencode(
      { id: "msg_1", timeCreated: 100, data: { role: "user", path: { cwd: "/work/app" } } },
      [part("part_1", 100, { type: "text", text: "hi" })],
      ctx,
    )
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      subIndex: 0,
      source: "opencode",
      msgType: "message",
      role: "user",
      content: { type: "text", value: "hi" },
      cwd: "/work/app",
      trackId: "main",
      timestamp: "1970-01-01T00:00:00.100Z",
    })
  })

  test("a finished tool part fans out into toolCall + toolResult, then a turnEvent", () => {
    const messages = normalizeOpencode(
      assistant("msg_2", 200),
      [
        part("part_tool", 200, {
          type: "tool",
          tool: "bash",
          callID: "c1",
          state: { status: "completed", input: { command: "ls" }, output: "x" },
        }),
        part("part_fin", 250, { type: "step-finish", reason: "tool-calls" }),
      ],
      ctx,
    )
    expect(messages.map((m) => [m.msgType, m.subIndex])).toEqual([
      ["toolCall", 0],
      ["toolResult", 1],
      ["turnEvent", 2],
    ])
    expect(messages[0]?.msgType === "toolCall" ? messages[0].details : undefined).toEqual({
      callId: "c1",
      name: "bash",
      input: { command: "ls" },
      metadata: { type: "shell", command: "ls" },
    })
    expect(messages[1]?.msgType === "toolResult" ? messages[1].details : undefined).toEqual({
      callId: "c1",
      output: "x",
      status: "success",
    })
    expect(messages[2]?.msgType === "turnEvent" ? messages[2].details : undefined).toEqual({
      type: "duration",
      status: "completed",
    })
  })

  test("an errored tool part produces a failure result and an aborted turnEvent", () => {
    const messages = normalizeOpencode(
      assistant("msg_3", 300),
      [
        part("part_tool", 300, {
          type: "tool",
          tool: "bash",
          callID: "c2",
          state: { status: "error", input: { command: "rm" }, output: "denied" },
        }),
        part("part_fin", 350, { type: "step-finish", reason: "error", error: "boom" }),
      ],
      ctx,
    )
    expect(messages.find((m) => m.msgType === "toolResult")?.details).toMatchObject({
      callId: "c2",
      status: "failure",
    })
    expect(messages.find((m) => m.msgType === "turnEvent")?.details).toEqual({
      type: "aborted",
      status: "aborted",
      reason: "boom",
    })
  })

  test("reasoning and text parts become assistant messages; tokens ride the first text part", () => {
    const messages = normalizeOpencode(
      assistant("msg_4", 400, {
        tokens: { total: 200, input: 100, output: 90, reasoning: 10, cache: { read: 5, write: 0 } },
      }),
      [
        part("part_r", 400, { type: "reasoning", text: "thinking..." }),
        part("part_t", 410, { type: "text", text: "hello there" }),
        part("part_t2", 420, { type: "text", text: "and more" }),
      ],
      ctx,
    )
    expect(messages).toHaveLength(3)
    expect(messages[0]).toMatchObject({
      msgType: "message",
      role: "assistant",
      content: { type: "reasoning", value: "thinking..." },
    })
    expect(messages[1]).toMatchObject({
      msgType: "message",
      role: "assistant",
      content: { type: "text", value: "hello there" },
      tokens: { input: 100, output: 90, cached: 5, thinking: 10 },
    })
    expect(messages[2]?.msgType === "message" ? messages[2].tokens : "set").toBeUndefined()
  })

  test("file and patch parts become fileEvents; unknown part types fall through as custom", () => {
    const messages = normalizeOpencode(
      assistant("msg_5", 500),
      [
        part("part_s", 500, { type: "step-start", snapshot: "abc" }),
        part("part_f", 500, { type: "file", path: "docs/a.md" }),
        part("part_p", 500, { type: "patch", path: "src/b.ts" }),
        part("part_x", 500, { type: "future-kind", whatever: true }),
      ],
      ctx,
    )
    expect(messages.map((m) => (m.msgType === "custom" ? m.subType : m.msgType))).toEqual([
      "step-start",
      "fileEvent",
      "fileEvent",
      "future-kind",
    ])
    expect(messages[1]?.msgType === "fileEvent" ? messages[1].details : undefined).toEqual({
      type: "attached",
      path: "docs/a.md",
    })
    expect(messages[2]?.msgType === "fileEvent" ? messages[2].details : undefined).toEqual({
      type: "edited",
      path: "src/b.ts",
    })
  })

  test("a subagent context stamps agentId and its track onto every message", () => {
    const messages = normalizeOpencode(
      assistant("msg_6", 600),
      [part("part_t", 600, { type: "text", text: "found it" })],
      { sessionId: "ses_1", trackId: "agent:ses_sub", agentId: "ses_sub" },
    )
    expect(messages[0]).toMatchObject({ agentId: "ses_sub", trackId: "agent:ses_sub" })
  })

  test("subIndex is reserved per part, so a tool finishing between captures shifts nothing", () => {
    const parts = (statusA: string) => [
      part("part_r", 700, { type: "reasoning", text: "plan" }),
      part("part_a", 701, {
        type: "tool",
        tool: "bash",
        callID: "a",
        state: { status: statusA, input: { command: "sleep 9" }, output: "done a" },
      }),
      part("part_b", 702, {
        type: "tool",
        tool: "bash",
        callID: "b",
        state: { status: "completed", input: { command: "ls" }, output: "done b" },
      }),
      part("part_t", 703, { type: "text", text: "both done" }),
    ]
    const key = (m: (typeof running)[number]) =>
      `${m.subIndex}:${m.msgType}:${m.msgType === "toolCall" || m.msgType === "toolResult" ? m.details.callId : ""}`

    const running = normalizeOpencode(assistant("msg_7", 700), parts("running"), ctx)
    const finished = normalizeOpencode(assistant("msg_7", 700), parts("completed"), ctx)

    expect(running.map(key)).toEqual([
      "0:message:",
      "2:toolCall:a",
      "4:toolCall:b",
      "5:toolResult:b",
      "6:message:",
    ])
    expect(finished.map(key)).toEqual([
      "0:message:",
      "2:toolCall:a",
      "3:toolResult:a",
      "4:toolCall:b",
      "5:toolResult:b",
      "6:message:",
    ])
  })
})

describe("tool metadata (opencode)", () => {
  const ctx = { sessionId: "ses_1", trackId: "main" }
  const message = { id: "msg_t", timeCreated: 100, data: { role: "assistant" } }
  const toolPart = (tool: string, state: Record<string, unknown>) => ({
    id: "part_t",
    timeCreated: 100,
    data: { type: "tool", tool, callID: "c1", state },
  })
  const metadataOf = (tool: string, state: Record<string, unknown>) => {
    const [call, result] = normalizeOpencode(message, [toolPart(tool, state)], ctx)
    return {
      call: call?.msgType === "toolCall" ? call.details.metadata : "not a call",
      result:
        result === undefined
          ? "no result"
          : result.msgType === "toolResult"
            ? result.details.metadata
            : "not a result",
    }
  }

  test("a bash call is a shell effect carrying its command", () => {
    expect(
      metadataOf("bash", { status: "completed", input: { command: "git status" }, output: "" }),
    ).toEqual({
      call: { type: "shell", command: "git status" },
      result: undefined,
    })
  })

  test("a completed write is a wrote effect that created the file; edit and patch did not", () => {
    expect(
      metadataOf("write", {
        status: "completed",
        input: { filePath: "src/a.ts", content: "x" },
        output: "",
      }).result,
    ).toEqual({ type: "wrote", path: "src/a.ts", created: true })
    expect(
      metadataOf("edit", {
        status: "completed",
        input: { file_path: "src/b.ts", oldString: "a", newString: "b" },
      }).result,
    ).toEqual({ type: "wrote", path: "src/b.ts", created: false })
    expect(
      metadataOf("patch", { status: "completed", input: { filePath: "src/c.ts" } }).result,
    ).toEqual({
      type: "wrote",
      path: "src/c.ts",
      created: false,
    })
  })

  test("a write that is still running, or failed, wrote nothing", () => {
    expect(metadataOf("write", { status: "running", input: { filePath: "src/a.ts" } }).result).toBe(
      "no result",
    )
    expect(
      metadataOf("write", { status: "error", input: { filePath: "src/a.ts" }, output: "denied" })
        .result,
    ).toBeUndefined()
  })

  test("an unmapped tool carries no metadata on either side", () => {
    expect(
      metadataOf("read", { status: "completed", input: { filePath: "src/a.ts" }, output: "..." }),
    ).toEqual({
      call: undefined,
      result: undefined,
    })
  })
})

describe("createOpencodePlugin", () => {
  test("a main session yields one main track whose record carries a uuid and a redacted raw with parts", async () => {
    const db = newDatabase()
    insertSession(db, { id: "ses_main", title: "Build the thing" })
    userTurn(db, "ses_main")
    insertMessage(db, {
      id: "msg_a",
      sessionId: "ses_main",
      timeCreated: 1_100,
      data: { role: "assistant", path: { cwd: "/work/app" }, apiKey: "sk-live" },
    })
    insertPart(db, {
      id: "part_a",
      messageId: "msg_a",
      sessionId: "ses_main",
      timeCreated: 1_100,
      data: {
        type: "tool",
        tool: "bash",
        callID: "c1",
        state: {
          status: "completed",
          input: { command: "curl", token: "abc" },
          output: { token: "xyz", body: "ok" },
        },
      },
    })

    const plugin = createOpencodePlugin({ db: wrap(db) })
    const batches = await plugin.collect(empty, collectDeps())
    expect(batches).toHaveLength(1)
    const track = batches[0]?.tracks[0]
    if (track?.type !== "main") throw new Error("expected main track")
    expect(track.source).toBe("opencode")
    expect(track.title).toBe("Build the thing")
    expect(track.checkpointKey).toBe("opencode:ses_main")
    expect(track.checkpointAt(1)).toEqual({
      source: "opencode",
      timeUpdated: 1_000,
      lastMessageId: "msg_a",
    })
    expect(track.records.map((record) => record.lineNumber)).toEqual([1, 2])

    const record = track.records[1]
    expect(record?.lineUuid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
    expect(record?.raw).toEqual({
      role: "assistant",
      path: { cwd: "/work/app" },
      apiKey: "[Redacted]",
      parts: [
        {
          type: "tool",
          tool: "bash",
          callID: "c1",
          state: {
            status: "completed",
            input: { command: "curl", token: "[Redacted]" },
            output: { token: "[Redacted]", body: "ok" },
          },
        },
      ],
    })
    const call = record?.messages[0]
    expect(call?.msgType === "toolCall" ? call.details.input : undefined).toEqual({
      command: "curl",
      token: "[Redacted]",
    })
    for (const message of track.records.flatMap((item) => item.messages)) {
      expect(normalizedMessageSchema.safeParse(message).success).toBe(true)
    }
  })

  test("a session with parent_id is grouped under its parent's batch as a subagent track", async () => {
    const db = newDatabase()
    insertSession(db, { id: "ses_main", timeUpdated: 2_000 })
    insertSession(db, {
      id: "ses_sub",
      parentId: "ses_main",
      timeCreated: 1_500,
      timeUpdated: 1_800,
      agent: "explore",
    })
    userTurn(db, "ses_main")
    insertMessage(db, {
      id: "msg_sub",
      sessionId: "ses_sub",
      timeCreated: 1_500,
      data: { role: "assistant", path: { cwd: "/work/app" } },
    })
    insertPart(db, {
      id: "part_sub",
      messageId: "msg_sub",
      sessionId: "ses_sub",
      timeCreated: 1_500,
      data: { type: "text", text: "found it" },
    })

    const plugin = createOpencodePlugin({ db: wrap(db) })
    const batches = await plugin.collect(empty, collectDeps())
    expect(batches).toHaveLength(1)
    const tracks = batches[0]?.tracks ?? []
    expect(tracks.map((t) => t.type)).toEqual(["main", "subagent"])
    const sub = tracks[1]
    if (sub?.type !== "subagent") throw new Error("expected subagent")
    expect(sub.agent).toEqual({ agentId: "ses_sub", agentType: "explore" })
    expect(sub.records[0]?.messages[0]).toMatchObject({
      role: "assistant",
      agentId: "ses_sub",
      trackId: "agent:ses_sub",
    })
  })

  test("a checkpoint older than time_updated re-emits the session; one at or after it emits nothing", async () => {
    const db = newDatabase()
    insertSession(db, { id: "ses_x", timeUpdated: 1_000 })
    userTurn(db, "ses_x")
    const plugin = createOpencodePlugin({ db: wrap(db) })

    const stale = await plugin.collect(
      { checkpoints: opencodeCheckpoint("ses_x", 0) },
      collectDeps(),
    )
    expect(stale[0]?.tracks[0]?.records).toHaveLength(1)

    const current = await plugin.collect(
      { checkpoints: opencodeCheckpoint("ses_x", 1_000) },
      collectDeps(),
    )
    expect(current).toHaveLength(0)
  })

  test("a current parent still ships the children that moved, and only those", async () => {
    const db = newDatabase()
    insertSession(db, { id: "ses_m", timeUpdated: 2_000 })
    insertSession(db, { id: "ses_m_a", parentId: "ses_m", timeUpdated: 1_800, agent: "explore" })
    insertSession(db, { id: "ses_m_b", parentId: "ses_m", timeUpdated: 3_000, agent: "build" })
    userTurn(db, "ses_m")
    userTurn(db, "ses_m_a", 1_700)
    userTurn(db, "ses_m_b", 2_500)

    const plugin = createOpencodePlugin({ db: wrap(db) })
    const batches = await plugin.collect(
      {
        checkpoints: {
          ...opencodeCheckpoint("ses_m", 2_000),
          ...opencodeCheckpoint("ses_m_a", 1_800),
          ...opencodeCheckpoint("ses_m_b", 1_000),
        },
      },
      collectDeps(),
    )
    expect(batches).toHaveLength(1)
    expect(batches[0]?.sessionId).toBe("ses_m")
    const tracks = batches[0]?.tracks ?? []
    expect(tracks.map((t) => t.type)).toEqual(["subagent"])
    expect(tracks[0]?.type === "subagent" ? tracks[0].agent.agentId : undefined).toBe("ses_m_b")
  })

  test("a session with no messages is not a batch", async () => {
    const db = newDatabase()
    insertSession(db, { id: "ses_empty" })
    const plugin = createOpencodePlugin({ db: wrap(db) })
    expect(await plugin.collect(empty, collectDeps())).toHaveLength(0)
  })

  test("shouldCapture false drops the whole family; an unresolvable directory does too", async () => {
    const db = newDatabase()
    insertSession(db, { id: "ses_z" })
    insertSession(db, { id: "ses_z_sub", parentId: "ses_z" })
    userTurn(db, "ses_z")
    userTurn(db, "ses_z_sub")
    // A fresh plugin each time: a resolved directory is cached for the plugin's lifetime.
    const collect = (over: Partial<CollectDeps>) =>
      createOpencodePlugin({ db: wrap(db) }).collect(empty, collectDeps(over))

    expect(await collect({ shouldCapture: async () => false })).toHaveLength(0)
    expect(await collect({ resolveProject: async () => null })).toHaveLength(0)
  })

  test("syncFrom cutoff skips a session created before it", async () => {
    const db = newDatabase()
    insertSession(db, { id: "ses_old", timeCreated: 1_000, timeUpdated: 5_000 })
    userTurn(db, "ses_old")
    const plugin = createOpencodePlugin({ db: wrap(db) })
    const batches = await plugin.collect(
      empty,
      collectDeps({ syncFromFor: async () => "2026-01-01T00:00:00.000Z" }),
    )
    expect(batches).toHaveLength(0)
  })

  test("a claude checkpoint stored under the opencode key does not silence the session", async () => {
    const db = newDatabase()
    insertSession(db, { id: "ses_k" })
    userTurn(db, "ses_k")
    const plugin = createOpencodePlugin({ db: wrap(db) })
    const batches = await plugin.collect(
      {
        checkpoints: {
          "opencode:ses_k": {
            source: "claude_code",
            filePath: "opencode:ses_k",
            lastUpdatedAt: "2026-08-01T00:00:00.000Z",
            mtime: 0,
            size: 0,
            lineProcessed: 0,
          },
        },
      },
      collectDeps(),
    )
    expect(batches).toHaveLength(1)
  })

  test("openDatabase opens a real sqlite file read-only and the plugin can query it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "samskara-opencode-"))
    const dbPath = join(dir, "opencode.db")
    const seed = newDatabase(dbPath)
    insertSession(seed, { id: "ses_real" })
    userTurn(seed, "ses_real")
    seed.close()

    const opened = openDatabase(dbPath)
    const plugin = createOpencodePlugin({ db: opened })
    const batches = await plugin.collect(empty, collectDeps())
    expect(batches[0]?.sessionId).toBe("ses_real")
    opened.close()

    expect(() => openDatabase(join(dir, "missing.db"))).toThrow()
  })
})

describe("defaultDbPath", () => {
  test("returns ~/.local/share/opencode/opencode.db on a unix-style home", () => {
    expect(defaultDbPath("/home/me")).toBe("/home/me/.local/share/opencode/opencode.db")
  })
})
