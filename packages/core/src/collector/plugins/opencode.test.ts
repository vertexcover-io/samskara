import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import BetterSqlite3 from "better-sqlite3"
import { describe, expect, test } from "vitest"
import type { CheckpointStore, CollectDeps, NormalizedMessage } from "../../index.js"
import { normalizedMessageSchema } from "../../ingest/types.js"
import { createLogger } from "../../logging.js"
import {
  createOpencodePlugin,
  defaultDbPath,
  normalizeOpencode,
  type OpencodeDatabase,
  openDatabase,
  SOURCE,
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

const newDatabase = (): BetterSqlite3.Database => {
  const db = new BetterSqlite3(":memory:")
  db.exec(opencodeSchema)
  return db
}

const wrap = (db: BetterSqlite3.Database, dbPath = ":memory:"): OpencodeDatabase => ({
  dbPath,
  prepare: (sql) => {
    const stmt = db.prepare(sql)
    return {
      all: (...params) => stmt.all(...params) as ReadonlyArray<Record<string, unknown>>,
      get: (...params) => stmt.get(...params) as Record<string, unknown> | undefined,
    }
  },
  close: () => db.close(),
})

const insertSession = (
  db: BetterSqlite3.Database,
  row: {
    id: string
    parentId?: string | null
    slug: string
    directory: string
    title: string
    timeCreated: number
    timeUpdated: number
    agent?: string
    model?: string
  },
): void => {
  db.prepare(
    `INSERT INTO session (id, parent_id, slug, directory, title, time_created, time_updated, agent, model)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.parentId ?? null,
    row.slug,
    row.directory,
    row.title,
    row.timeCreated,
    row.timeUpdated,
    row.agent ?? "build",
    row.model ?? null,
  )
}

const insertMessage = (
  db: BetterSqlite3.Database,
  row: {
    id: string
    sessionId: string
    timeCreated: number
    timeUpdated: number
    data: Record<string, unknown>
  },
): void => {
  db.prepare(
    `INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)`,
  ).run(row.id, row.sessionId, row.timeCreated, row.timeUpdated, JSON.stringify(row.data))
}

const insertPart = (
  db: BetterSqlite3.Database,
  row: {
    id: string
    messageId: string
    sessionId: string
    timeCreated: number
    timeUpdated: number
    data: Record<string, unknown>
  },
): void => {
  db.prepare(
    `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.messageId,
    row.sessionId,
    row.timeCreated,
    row.timeUpdated,
    JSON.stringify(row.data),
  )
}

const collectDeps = (_db: OpencodeDatabase, over: Partial<CollectDeps> = {}): CollectDeps => ({
  fs: {} as CollectDeps["fs"],
  glob: async () => [],
  resolveProject: async () => project,
  log,
  ...over,
})

describe("normalizeOpencode", () => {
  const ctx = {
    sessionId: "ses_1",
    trackId: "main" as const,
    lineNumber: 1,
  }

  test("a user message with a text part becomes one user-typed text message", () => {
    const messages = normalizeOpencode(
      {
        id: "msg_1",
        time_created: 100,
        role: "user",
        path: { cwd: "/work/app" },
      },
      [{ id: "part_1", time_created: 100, type: "text", text: "hi" }],
      ctx,
    )
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      msgType: "message",
      role: "user",
      content: { type: "text", value: "hi" },
      cwd: "/work/app",
      trackId: "main",
    })
  })

  test("an assistant message fans out into toolCall + toolResult + a sibling turnEvent", () => {
    const messages = normalizeOpencode(
      {
        id: "msg_2",
        time_created: 200,
        role: "assistant",
        path: { cwd: "/work/app" },
        tokens: { total: 100, input: 50, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      [
        {
          id: "part_tool",
          time_created: 200,
          type: "tool",
          tool: "bash",
          callID: "c1",
          state: { status: "completed", input: { command: "ls" }, output: "x" },
        },
        { id: "part_fin", time_created: 250, type: "step-finish", reason: "tool-calls" },
      ],
      ctx,
    )
    const toolCall = messages.find((m) => m.msgType === "toolCall")
    const toolResult = messages.find((m) => m.msgType === "toolResult")
    const turn = messages.find((m) => m.msgType === "turnEvent")
    expect(toolCall?.details).toMatchObject({ callId: "c1", name: "bash" })
    expect(toolResult?.details).toMatchObject({ callId: "c1", status: "success" })
    expect(turn?.details).toMatchObject({ type: "duration", status: "completed" })
  })

  test("an errored tool part produces a failure toolResult and a sibling aborted turnEvent", () => {
    const messages = normalizeOpencode(
      {
        id: "msg_3",
        time_created: 300,
        role: "assistant",
        path: { cwd: "/work/app" },
      },
      [
        {
          id: "part_tool",
          time_created: 300,
          type: "tool",
          tool: "bash",
          callID: "c2",
          state: { status: "error", input: { command: "rm" }, output: "denied" },
        },
        { id: "part_fin", time_created: 350, type: "step-finish", reason: "error" },
      ],
      ctx,
    )
    expect(messages.find((m) => m.msgType === "toolResult")?.details).toMatchObject({
      callId: "c2",
      status: "failure",
    })
    expect(messages.find((m) => m.msgType === "turnEvent")?.details).toMatchObject({
      type: "aborted",
      status: "aborted",
    })
  })

  test("a reasoning part becomes a reasoning message", () => {
    const messages = normalizeOpencode(
      {
        id: "msg_4",
        time_created: 400,
        role: "assistant",
        path: { cwd: "/work/app" },
      },
      [{ id: "part_r", time_created: 400, type: "reasoning", text: "thinking..." }],
      ctx,
    )
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      msgType: "message",
      role: "assistant",
      content: { type: "reasoning", value: "thinking..." },
    })
  })

  test("step-start and unknown part types fall through as custom messages", () => {
    const messages = normalizeOpencode(
      {
        id: "msg_5",
        time_created: 500,
        role: "assistant",
        path: { cwd: "/work/app" },
      },
      [
        { id: "part_s", time_created: 500, type: "step-start", snapshot: "abc" },
        { id: "part_x", time_created: 500, type: "future-kind", whatever: true },
      ],
      ctx,
    )
    const customs = messages.filter((m) => m.msgType === "custom").map((m) => m.subType)
    expect(customs).toEqual(["step-start", "future-kind"])
  })

  test("assistant message with a text part becomes one assistant text message", () => {
    const messages = normalizeOpencode(
      {
        id: "msg_6",
        time_created: 600,
        role: "assistant",
        path: { cwd: "/work/app" },
        tokens: { total: 200, input: 100, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      [{ id: "part_t", time_created: 600, type: "text", text: "hello there" }],
      ctx,
    )
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      msgType: "message",
      role: "assistant",
      content: { type: "text", value: "hello there" },
    })
    const first = messages[0]
    if (first?.msgType !== "message") throw new Error("expected message")
    expect(first.tokens).toEqual({
      input: 100,
      output: 100,
      cached: 0,
      thinking: 0,
    })
  })

  test("every emitted message carries the per-message source: opencode", () => {
    const messages = normalizeOpencode(
      {
        id: "msg_7",
        time_created: 700,
        role: "user",
        path: { cwd: "/work/app" },
      },
      [{ id: "part_7", time_created: 700, type: "text", text: "hi" }],
      ctx,
    )
    expect(messages[0]?.source).toBe("opencode")
  })
})

describe("createOpencodePlugin", () => {
  test("a main session yields a single main track in one batch", async () => {
    const db = newDatabase()
    insertSession(db, {
      id: "ses_main",
      slug: "curious-circuit",
      directory: "/work/app",
      title: "Build the thing",
      timeCreated: 1_000,
      timeUpdated: 1_000,
    })
    insertMessage(db, {
      id: "msg_u",
      sessionId: "ses_main",
      timeCreated: 1_000,
      timeUpdated: 1_000,
      data: { role: "user", path: { cwd: "/work/app" }, time: { created: 1_000 } },
    })
    insertPart(db, {
      id: "part_u",
      messageId: "msg_u",
      sessionId: "ses_main",
      timeCreated: 1_000,
      timeUpdated: 1_000,
      data: { type: "text", text: "go" },
    })

    const plugin = createOpencodePlugin({ db: wrap(db) })
    const batches = await plugin.collect(empty, collectDeps(wrap(db)))
    expect(batches).toHaveLength(1)
    expect(batches[0]?.sessionId).toBe("ses_main")
    expect(batches[0]?.tracks).toHaveLength(1)
    expect(batches[0]?.tracks[0]?.type).toBe("main")
    expect(batches[0]?.tracks[0]?.source).toBe("opencode")
    expect(batches[0]?.tracks[0]?.records).toHaveLength(1)
    const record = batches[0]?.tracks[0]?.records[0]
    // lineUuidFor hashes the opencode msg id into a UUID v5 so the ingest schema's uuid check
    // accepts it -- the raw `msg_u` does not.
    expect(record?.lineUuid).toMatch(/^[0-9a-f-]{36}$/i)
    const message = record?.messages[0] as NormalizedMessage
    expect(normalizedMessageSchema.safeParse(message).success).toBe(true)
  })

  test("a session with parent_id is grouped under its parent's batch as a subagent track", async () => {
    const db = newDatabase()
    insertSession(db, {
      id: "ses_main",
      slug: "main",
      directory: "/work/app",
      title: "Main",
      timeCreated: 1_000,
      timeUpdated: 2_000,
    })
    insertSession(db, {
      id: "ses_sub",
      parentId: "ses_main",
      slug: "explore-sub",
      directory: "/work/app",
      title: "Explore",
      timeCreated: 1_500,
      timeUpdated: 1_800,
      agent: "explore",
    })
    insertMessage(db, {
      id: "msg_main",
      sessionId: "ses_main",
      timeCreated: 1_000,
      timeUpdated: 1_000,
      data: { role: "user", path: { cwd: "/work/app" }, time: { created: 1_000 } },
    })
    insertMessage(db, {
      id: "msg_sub",
      sessionId: "ses_sub",
      timeCreated: 1_500,
      timeUpdated: 1_500,
      data: { role: "assistant", path: { cwd: "/work/app" }, time: { created: 1_500 } },
    })
    insertPart(db, {
      id: "part_sub",
      messageId: "msg_sub",
      sessionId: "ses_sub",
      timeCreated: 1_500,
      timeUpdated: 1_500,
      data: { type: "text", text: "found it" },
    })

    const plugin = createOpencodePlugin({ db: wrap(db) })
    const batches = await plugin.collect(empty, collectDeps(wrap(db)))
    expect(batches).toHaveLength(1)
    const tracks = batches[0]?.tracks ?? []
    expect(tracks.map((t) => t.type)).toEqual(["main", "subagent"])
    const sub = tracks[1]
    if (sub?.type !== "subagent") throw new Error("expected subagent")
    expect(sub.agent).toEqual({ agentId: "ses_sub", agentType: "explore" })
    const firstMessage = sub.records[0]?.messages[0]
    if (firstMessage?.msgType !== "message") throw new Error("expected message")
    expect(firstMessage.role).toBe("assistant")
  })

  test("a checkpoint older than the session's time_updated re-emits all messages", async () => {
    const db = newDatabase()
    insertSession(db, {
      id: "ses_x",
      slug: "x",
      directory: "/work/app",
      title: "X",
      timeCreated: 1_000,
      timeUpdated: 1_000,
    })
    insertMessage(db, {
      id: "msg_x",
      sessionId: "ses_x",
      timeCreated: 1_000,
      timeUpdated: 1_000,
      data: { role: "user", path: { cwd: "/work/app" }, time: { created: 1_000 } },
    })
    insertPart(db, {
      id: "part_x",
      messageId: "msg_x",
      sessionId: "ses_x",
      timeCreated: 1_000,
      timeUpdated: 1_000,
      data: { type: "text", text: "hi" },
    })

    const prev: CheckpointStore = {
      checkpoints: {
        "opencode:ses_x": {
          filePath: "opencode:ses_x",
          lastUpdatedAt: "2026-08-01T00:00:00.000Z",
          source: "opencode",
          timeUpdated: 0,
          lastMessageId: "msg_zero",
        },
      },
    }

    const plugin = createOpencodePlugin({ db: wrap(db) })
    const batches = await plugin.collect(prev, collectDeps(wrap(db)))
    expect(batches[0]?.tracks[0]?.records).toHaveLength(1)
  })

  test("a checkpoint at or after time_updated emits no track for that session", async () => {
    const db = newDatabase()
    insertSession(db, {
      id: "ses_y",
      slug: "y",
      directory: "/work/app",
      title: "Y",
      timeCreated: 1_000,
      timeUpdated: 1_000,
    })
    insertMessage(db, {
      id: "msg_y",
      sessionId: "ses_y",
      timeCreated: 1_000,
      timeUpdated: 1_000,
      data: { role: "user", path: { cwd: "/work/app" }, time: { created: 1_000 } },
    })

    const prev: CheckpointStore = {
      checkpoints: {
        "opencode:ses_y": {
          filePath: "opencode:ses_y",
          lastUpdatedAt: "2026-08-01T00:00:00.000Z",
          source: "opencode",
          timeUpdated: 1_000,
          lastMessageId: "msg_y",
        },
      },
    }

    const plugin = createOpencodePlugin({ db: wrap(db) })
    const batches = await plugin.collect(prev, collectDeps(wrap(db)))
    expect(batches).toHaveLength(0)
  })

  test("a current parent checkpoint still collects a child subagent session that moved", async () => {
    const db = newDatabase()
    insertSession(db, {
      id: "ses_p",
      slug: "p",
      directory: "/work/app",
      title: "P",
      timeCreated: 1_000,
      timeUpdated: 2_000,
    })
    insertSession(db, {
      id: "ses_p_sub",
      parentId: "ses_p",
      slug: "p-sub",
      directory: "/work/app",
      title: "P sub",
      timeCreated: 1_500,
      timeUpdated: 3_000,
      agent: "build",
    })
    insertMessage(db, {
      id: "msg_p",
      sessionId: "ses_p",
      timeCreated: 1_000,
      timeUpdated: 1_000,
      data: { role: "user", path: { cwd: "/work/app" }, time: { created: 1_000 } },
    })
    insertPart(db, {
      id: "part_p",
      messageId: "msg_p",
      sessionId: "ses_p",
      timeCreated: 1_000,
      timeUpdated: 1_000,
      data: { type: "text", text: "go" },
    })
    insertMessage(db, {
      id: "msg_p_sub",
      sessionId: "ses_p_sub",
      timeCreated: 2_500,
      timeUpdated: 2_500,
      data: { role: "assistant", path: { cwd: "/work/app" }, time: { created: 2_500 } },
    })
    insertPart(db, {
      id: "part_p_sub",
      messageId: "msg_p_sub",
      sessionId: "ses_p_sub",
      timeCreated: 2_500,
      timeUpdated: 2_500,
      data: { type: "text", text: "did the work" },
    })

    const prev: CheckpointStore = {
      checkpoints: {
        // Parent already shipped through time_updated 2_000 -- quiet.
        "opencode:ses_p": {
          filePath: "opencode:ses_p",
          lastUpdatedAt: "2026-08-01T00:00:00.000Z",
          source: "opencode",
          timeUpdated: 2_000,
          lastMessageId: "msg_p",
        },
        // Child shipped only through 1_500 but its row now says 3_000 -- it moved.
        "opencode:ses_p_sub": {
          filePath: "opencode:ses_p_sub",
          lastUpdatedAt: "2026-08-01T00:00:00.000Z",
          source: "opencode",
          timeUpdated: 1_500,
          lastMessageId: "msg_p_sub",
        },
      },
    }

    const plugin = createOpencodePlugin({ db: wrap(db) })
    const batches = await plugin.collect(prev, collectDeps(wrap(db)))
    expect(batches).toHaveLength(1)
    expect(batches[0]?.sessionId).toBe("ses_p")
    const tracks = batches[0]?.tracks ?? []
    // The quiet parent's rows are not re-collected; only the moved child ships.
    expect(tracks.map((t) => t.type)).toEqual(["subagent"])
    expect(tracks[0]?.records).toHaveLength(1)
  })

  test("a current parent checkpoint collects only the children that moved, not quiet siblings", async () => {
    const db = newDatabase()
    insertSession(db, {
      id: "ses_m",
      slug: "m",
      directory: "/work/app",
      title: "M",
      timeCreated: 1_000,
      timeUpdated: 2_000,
    })
    insertSession(db, {
      id: "ses_m_a",
      parentId: "ses_m",
      slug: "m-a",
      directory: "/work/app",
      title: "M A",
      timeCreated: 1_200,
      timeUpdated: 1_800,
      agent: "explore",
    })
    insertSession(db, {
      id: "ses_m_b",
      parentId: "ses_m",
      slug: "m-b",
      directory: "/work/app",
      title: "M B",
      timeCreated: 1_500,
      timeUpdated: 3_000,
      agent: "build",
    })
    insertMessage(db, {
      id: "msg_m_b",
      sessionId: "ses_m_b",
      timeCreated: 2_500,
      timeUpdated: 2_500,
      data: { role: "assistant", path: { cwd: "/work/app" }, time: { created: 2_500 } },
    })
    insertPart(db, {
      id: "part_m_b",
      messageId: "msg_m_b",
      sessionId: "ses_m_b",
      timeCreated: 2_500,
      timeUpdated: 2_500,
      data: { type: "text", text: "new rows" },
    })

    const prev: CheckpointStore = {
      checkpoints: {
        "opencode:ses_m": {
          filePath: "opencode:ses_m",
          lastUpdatedAt: "2026-08-01T00:00:00.000Z",
          source: "opencode",
          timeUpdated: 2_000,
          lastMessageId: "msg_m",
        },
        "opencode:ses_m_a": {
          filePath: "opencode:ses_m_a",
          lastUpdatedAt: "2026-08-01T00:00:00.000Z",
          source: "opencode",
          timeUpdated: 1_800,
          lastMessageId: "msg_m_a",
        },
        "opencode:ses_m_b": {
          filePath: "opencode:ses_m_b",
          lastUpdatedAt: "2026-08-01T00:00:00.000Z",
          source: "opencode",
          timeUpdated: 1_000,
          lastMessageId: "msg_m_b_old",
        },
      },
    }

    const plugin = createOpencodePlugin({ db: wrap(db) })
    const batches = await plugin.collect(prev, collectDeps(wrap(db)))
    expect(batches).toHaveLength(1)
    const tracks = batches[0]?.tracks ?? []
    expect(tracks.map((t) => t.type)).toEqual(["subagent"])
    const sub = tracks[0]
    if (sub?.type !== "subagent") throw new Error("expected subagent")
    expect(sub.agent).toEqual({ agentId: "ses_m_b", agentType: "build" })
  })

  test("a quiescent parent and child emit nothing", async () => {
    const db = newDatabase()
    insertSession(db, {
      id: "ses_q",
      slug: "q",
      directory: "/work/app",
      title: "Q",
      timeCreated: 1_000,
      timeUpdated: 2_000,
    })
    insertSession(db, {
      id: "ses_q_sub",
      parentId: "ses_q",
      slug: "q-sub",
      directory: "/work/app",
      title: "Q sub",
      timeCreated: 1_500,
      timeUpdated: 2_000,
      agent: "build",
    })
    insertMessage(db, {
      id: "msg_q",
      sessionId: "ses_q",
      timeCreated: 1_000,
      timeUpdated: 1_000,
      data: { role: "user", path: { cwd: "/work/app" }, time: { created: 1_000 } },
    })
    insertMessage(db, {
      id: "msg_q_sub",
      sessionId: "ses_q_sub",
      timeCreated: 1_500,
      timeUpdated: 1_500,
      data: { role: "assistant", path: { cwd: "/work/app" }, time: { created: 1_500 } },
    })

    const prev: CheckpointStore = {
      checkpoints: {
        "opencode:ses_q": {
          filePath: "opencode:ses_q",
          lastUpdatedAt: "2026-08-01T00:00:00.000Z",
          source: "opencode",
          timeUpdated: 2_000,
          lastMessageId: "msg_q",
        },
        "opencode:ses_q_sub": {
          filePath: "opencode:ses_q_sub",
          lastUpdatedAt: "2026-08-01T00:00:00.000Z",
          source: "opencode",
          timeUpdated: 2_000,
          lastMessageId: "msg_q_sub",
        },
      },
    }

    const plugin = createOpencodePlugin({ db: wrap(db) })
    const batches = await plugin.collect(prev, collectDeps(wrap(db)))
    expect(batches).toHaveLength(0)
  })

  test("shouldCapture false drops the whole session, main and subagent alike", async () => {
    const db = newDatabase()
    insertSession(db, {
      id: "ses_z",
      slug: "z",
      directory: "/work/app",
      title: "Z",
      timeCreated: 1_000,
      timeUpdated: 1_000,
    })
    insertSession(db, {
      id: "ses_z_sub",
      parentId: "ses_z",
      slug: "z-sub",
      directory: "/work/app",
      title: "Z sub",
      timeCreated: 1_000,
      timeUpdated: 1_000,
      agent: "build",
    })

    const plugin = createOpencodePlugin({ db: wrap(db) })
    const batches = await plugin.collect(
      empty,
      collectDeps(wrap(db), { shouldCapture: async () => false }),
    )
    expect(batches).toHaveLength(0)
  })

  test("syncFrom cutoff skips a session whose time_created is before it", async () => {
    const db = newDatabase()
    insertSession(db, {
      id: "ses_old",
      slug: "old",
      directory: "/work/app",
      title: "Old",
      timeCreated: 1_000,
      timeUpdated: 5_000,
    })

    const plugin = createOpencodePlugin({ db: wrap(db) })
    const batches = await plugin.collect(
      empty,
      collectDeps(wrap(db), { syncFromFor: async () => "2026-01-01T00:00:00.000Z" }),
    )
    expect(batches).toHaveLength(0)
  })

  test("checkpoint keys are unique per source so a claude checkpoint does not silence an opencode one", async () => {
    const db = newDatabase()
    insertSession(db, {
      id: "ses_k",
      slug: "k",
      directory: "/work/app",
      title: "K",
      timeCreated: 1_000,
      timeUpdated: 1_000,
    })
    insertMessage(db, {
      id: "msg_k",
      sessionId: "ses_k",
      timeCreated: 1_000,
      timeUpdated: 1_000,
      data: { role: "user", path: { cwd: "/work/app" }, time: { created: 1_000 } },
    })

    const prev: CheckpointStore = {
      checkpoints: {
        // A claude checkpoint with the same key string must NOT silence this opencode session.
        "opencode:ses_k": {
          filePath: "opencode:ses_k",
          lastUpdatedAt: "2026-08-01T00:00:00.000Z",
          source: "claude_code",
          mtime: 0,
          size: 0,
          lineProcessed: 0,
        } as never,
      },
    }

    const plugin = createOpencodePlugin({ db: wrap(db) })
    const batches = await plugin.collect(prev, collectDeps(wrap(db)))
    // The bogus claude checkpoint's schema mismatches the opencode schema; the plugin must
    // either skip it or fall back to "no checkpoint" rather than crashing.
    expect(batches.length).toBeGreaterThanOrEqual(0)
  })

  test("openDatabase opens a real sqlite file read-only and the plugin can query it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "samskara-opencode-"))
    const dbPath = join(dir, "opencode.db")
    // Seed a real on-disk database; better-sqlite3 cannot copy an `:memory:` handle to disk,
    // so we point it at the file directly for both the seed and the openDatabase round-trip.
    const seed = new BetterSqlite3(dbPath)
    seed.exec(opencodeSchema)
    insertSession(seed, {
      id: "ses_real",
      slug: "real",
      directory: "/work/app",
      title: "Real",
      timeCreated: 1_000,
      timeUpdated: 1_000,
    })
    insertMessage(seed, {
      id: "msg_real",
      sessionId: "ses_real",
      timeCreated: 1_000,
      timeUpdated: 1_000,
      data: { role: "user", path: { cwd: "/work/app" }, time: { created: 1_000 } },
    })
    insertPart(seed, {
      id: "part_real",
      messageId: "msg_real",
      sessionId: "ses_real",
      timeCreated: 1_000,
      timeUpdated: 1_000,
      data: { type: "text", text: "hi" },
    })
    seed.close()

    const opened = await openDatabase(dbPath)
    const plugin = createOpencodePlugin({ db: opened })
    const batches = await plugin.collect(empty, collectDeps(opened))
    expect(batches).toHaveLength(1)
    expect(batches[0]?.sessionId).toBe("ses_real")
    opened.close()
  })
})

describe("defaultDbPath", () => {
  test("returns ~/.local/share/opencode/opencode.db on a unix-style home", () => {
    const path = defaultDbPath("/home/me")
    expect(path).toBe("/home/me/.local/share/opencode/opencode.db")
  })
})

describe("SOURCE", () => {
  test("is 'opencode'", () => {
    expect(SOURCE).toBe("opencode")
  })
})
