import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import { and, asc, eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { type Db, createDb } from "../db/client.js"
import {
  messages,
  projects,
  sessionChunk,
  sessions,
  toolCall,
  toolResult,
  users,
} from "../db/schema.js"
import * as projectsRepo from "./projects.repo.js"
import {
  type SourceRow,
  splitIntoParts,
  writeChunksForSession,
  writeTitleChunkForSession,
} from "./sessionChunks.repo.js"

const dockerAvailable = () => {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

const packageDir = fileURLToPath(new URL("../..", import.meta.url))

const sourceRow = (lineNumber: number, overrides: Partial<SourceRow> = {}): SourceRow => ({
  id: `row-${lineNumber}`,
  lineNumber,
  trackId: "main",
  agentId: null,
  msgType: "message",
  role: null,
  content: null,
  ...overrides,
})

describe("splitIntoParts", () => {
  test("D5: a turn of CHUNK_MAX_MESSAGES + 1 messages produces two parts with contiguous partIndex and no lost tail", () => {
    const max = 5
    const rows = Array.from({ length: max + 1 }, (_, i) => sourceRow(i + 1))

    const parts = splitIntoParts(rows, max)

    expect(parts).toHaveLength(2)
    expect(parts[0]?.partIndex).toBe(0)
    expect(parts[1]?.partIndex).toBe(1)
    expect(parts[0]?.rows).toHaveLength(max)
    expect(parts[1]?.rows).toHaveLength(1)
    expect(parts.flatMap((p) => p.rows)).toEqual(rows)
    expect(parts[0]?.startLineNumber).toBe(1)
    expect(parts[0]?.endLineNumber).toBe(max)
    expect(parts[1]?.startLineNumber).toBe(max + 1)
    expect(parts[1]?.endLineNumber).toBe(max + 1)
  })

  test("a turn under the boundary produces exactly one part", () => {
    const rows = [sourceRow(1), sourceRow(2)]

    const parts = splitIntoParts(rows, 5)

    expect(parts).toHaveLength(1)
    expect(parts[0]).toMatchObject({ partIndex: 0, startLineNumber: 1, endLineNumber: 2 })
  })

  test("an empty turn produces no parts", () => {
    expect(splitIntoParts([], 5)).toEqual([])
  })
})

describe.skipIf(!dockerAvailable())("writeChunksForSession", () => {
  let container: StartedPostgreSqlContainer
  let teardown: () => Promise<void>
  let db: Db

  let counter = 0
  const seedSession = async (id: string) => {
    counter += 1
    const [user] = await db
      .insert(users)
      .values({ githubId: 700 + counter, githubLogin: `chunk-user-${counter}` })
      .returning()
    if (!user) throw new Error("seed user failed")
    const projectId = await projectsRepo.upsert(db, {
      identity: { name: id, slug: `slug-${id}` },
      ownerId: user.id,
    })
    await db.insert(sessions).values({ id, source: "claude_code", userId: user.id, projectId })
    return { userId: user.id, projectId }
  }

  const insertMessage = async (input: {
    sessionId: string
    lineNumber: number
    msgType: string
    role?: string
    trackId?: string
    agentId?: string
    content?: unknown
  }): Promise<string> => {
    const [row] = await db
      .insert(messages)
      .values({
        sessionId: input.sessionId,
        lineUuid: crypto.randomUUID(),
        subIndex: 0,
        msgType: input.msgType,
        role: input.role,
        lineNumber: input.lineNumber,
        trackId: input.trackId ?? "main",
        agentId: input.agentId,
        content: input.content,
        raw: {},
        sourceSchemaVersion: 1,
      })
      .returning({ id: messages.id })
    if (!row) throw new Error("no seeded message")
    return row.id
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg16").start()
    const url = container.getConnectionUri()
    execFileSync("bun", ["run", "db:migrate"], {
      cwd: packageDir,
      env: { ...process.env, DATABASE_URL: url },
      stdio: "inherit",
    })
    const created = createDb(url)
    db = created.db
    teardown = async () => {
      await created.client.end()
      await container.stop()
    }
  }, 120_000)

  afterAll(async () => {
    await teardown?.()
  })

  test("D7/D13: a closed turn becomes one searchable chunk row whose range covers it and whose anchor is the opening message", async () => {
    const sessionId = "sess-chunk-basic"
    await seedSession(sessionId)
    const opener = await insertMessage({
      sessionId,
      lineNumber: 1,
      msgType: "message",
      role: "user",
      content: { type: "text", value: "investigate the leak" },
    })
    await insertMessage({
      sessionId,
      lineNumber: 2,
      msgType: "message",
      role: "assistant",
      content: { type: "text", value: "looking now" },
    })
    await insertMessage({ sessionId, lineNumber: 3, msgType: "message", role: "user" })

    const written = await writeChunksForSession(db, sessionId)

    expect(written).toBe(1)
    const rows = await db.select().from(sessionChunk).where(eq(sessionChunk.sessionId, sessionId))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      kind: "turn",
      trackId: "main",
      partIndex: 0,
      startLineNumber: 1,
      endLineNumber: 2,
      anchorMessageId: opener,
      embedding: null,
    })
    expect(rows[0]?.searchText).toContain("investigate the leak")
    expect(rows[0]?.searchText).toContain("looking now")
  })

  test("D6: the in-flight (never-closed) turn produces no chunk", async () => {
    const sessionId = "sess-chunk-open"
    await seedSession(sessionId)
    await insertMessage({ sessionId, lineNumber: 1, msgType: "message", role: "user" })
    await insertMessage({ sessionId, lineNumber: 2, msgType: "message", role: "assistant" })

    expect(await writeChunksForSession(db, sessionId)).toBe(0)
    expect(
      await db.select().from(sessionChunk).where(eq(sessionChunk.sessionId, sessionId)),
    ).toHaveLength(0)
  })

  test("D2: a tool call/result pair's names and inputs land in the chunk's searchText, and the result is included too", async () => {
    const sessionId = "sess-chunk-tools"
    await seedSession(sessionId)
    await insertMessage({ sessionId, lineNumber: 1, msgType: "message", role: "user" })
    const callId = await insertMessage({ sessionId, lineNumber: 2, msgType: "toolCall" })
    const resultId = await insertMessage({ sessionId, lineNumber: 3, msgType: "toolResult" })
    await insertMessage({ sessionId, lineNumber: 4, msgType: "message", role: "user" })

    await db.insert(toolCall).values({
      toolId: "tool-1",
      messageId: callId,
      toolName: "Grep",
      toolInput: { pattern: "TODO" },
    })
    await db.insert(toolResult).values({
      toolId: "tool-1",
      messageId: resultId,
      result: "match in file-a.ts",
      status: "success",
    })

    await writeChunksForSession(db, sessionId)

    const [row] = await db.select().from(sessionChunk).where(eq(sessionChunk.sessionId, sessionId))
    expect(row?.searchText).toContain("Grep")
    expect(row?.searchText).toContain("TODO")
    expect(row?.searchText).toContain("match in file-a.ts")
    expect(row?.embedText).toContain("Grep")
    expect(row?.embedText).not.toContain("match in file-a.ts")
  })

  test("D4: two interleaved tracks each become their own chunk, tagged with the subagent's agentId", async () => {
    const sessionId = "sess-chunk-tracks"
    await seedSession(sessionId)
    await insertMessage({
      sessionId,
      lineNumber: 1,
      msgType: "message",
      role: "user",
      trackId: "main",
    })
    await insertMessage({
      sessionId,
      lineNumber: 1,
      msgType: "message",
      role: "user",
      trackId: "agent:a",
      agentId: "a",
    })
    await insertMessage({
      sessionId,
      lineNumber: 2,
      msgType: "message",
      role: "user",
      trackId: "main",
    })
    await insertMessage({
      sessionId,
      lineNumber: 2,
      msgType: "message",
      role: "user",
      trackId: "agent:a",
      agentId: "a",
    })

    expect(await writeChunksForSession(db, sessionId)).toBe(2)
    const rows = await db
      .select({ trackId: sessionChunk.trackId, agentId: sessionChunk.agentId })
      .from(sessionChunk)
      .where(eq(sessionChunk.sessionId, sessionId))
      .orderBy(asc(sessionChunk.trackId))
    expect(rows).toEqual([
      { trackId: "agent:a", agentId: "a" },
      { trackId: "main", agentId: null },
    ])
  })

  test("re-running writeChunksForSession on the same session writes no duplicate rows", async () => {
    const sessionId = "sess-chunk-idempotent"
    await seedSession(sessionId)
    await insertMessage({ sessionId, lineNumber: 1, msgType: "message", role: "user" })
    await insertMessage({ sessionId, lineNumber: 2, msgType: "message", role: "user" })

    expect(await writeChunksForSession(db, sessionId)).toBe(1)
    expect(await writeChunksForSession(db, sessionId)).toBe(0)

    expect(
      await db.select().from(sessionChunk).where(eq(sessionChunk.sessionId, sessionId)),
    ).toHaveLength(1)
  })

  test("D13: a session whose messages predate the feature becomes searchable after one chunker run", async () => {
    const sessionId = "sess-chunk-backfill"
    await seedSession(sessionId)
    // Messages inserted directly, as if by an ingest that ran before sessionChunk existed.
    await insertMessage({
      sessionId,
      lineNumber: 1,
      msgType: "message",
      role: "user",
      content: { type: "text", value: "pre-existing session content" },
    })
    await insertMessage({ sessionId, lineNumber: 2, msgType: "message", role: "user" })

    expect(
      await db.select().from(sessionChunk).where(eq(sessionChunk.sessionId, sessionId)),
    ).toHaveLength(0)

    expect(await writeChunksForSession(db, sessionId)).toBe(1)

    const [row] = await db.select().from(sessionChunk).where(eq(sessionChunk.sessionId, sessionId))
    expect(row?.searchText).toContain("pre-existing session content")
  })

  test("D10: a 1024-element vector inserts into embedding and reads back equal", async () => {
    const sessionId = "sess-chunk-vector"
    await seedSession(sessionId)
    const opener = await insertMessage({
      sessionId,
      lineNumber: 1,
      msgType: "message",
      role: "user",
    })
    const vector = Array.from({ length: 1024 }, (_, i) => i / 1000)

    await db.insert(sessionChunk).values({
      sessionId,
      kind: "turn",
      trackId: "main",
      partIndex: 0,
      startLineNumber: 1,
      endLineNumber: 1,
      anchorMessageId: opener,
      searchText: "vector round trip",
      embedText: "vector round trip",
      embedding: vector,
    })

    const [row] = await db.select().from(sessionChunk).where(eq(sessionChunk.sessionId, sessionId))
    expect(row?.embedding).toEqual(vector)
  })

  const titleChunkRows = (sessionId: string) =>
    db
      .select()
      .from(sessionChunk)
      .where(and(eq(sessionChunk.sessionId, sessionId), eq(sessionChunk.kind, "title")))

  test("a session with no title produces no title chunk", async () => {
    const sessionId = "sess-title-absent"
    await seedSession(sessionId)

    await writeTitleChunkForSession(db, sessionId)

    expect(await titleChunkRows(sessionId)).toHaveLength(0)
  })

  test("D16: a titled session gets exactly one title chunk with a null anchor, trackId and line range", async () => {
    const sessionId = "sess-title-basic"
    await seedSession(sessionId)
    await db
      .update(sessions)
      .set({ title: "Investigate the leak" })
      .where(eq(sessions.id, sessionId))

    await writeTitleChunkForSession(db, sessionId)
    // Idempotent: re-running with an unchanged title must not duplicate the row.
    await writeTitleChunkForSession(db, sessionId)

    const rows = await titleChunkRows(sessionId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      trackId: null,
      agentId: null,
      startLineNumber: null,
      endLineNumber: null,
      anchorMessageId: null,
      searchText: "Investigate the leak",
      embedText: "Investigate the leak",
      embedding: null,
    })
  })

  test("D17: changing a session's title replaces its title chunk and nulls the embedding", async () => {
    const sessionId = "sess-title-change"
    await seedSession(sessionId)
    await db.update(sessions).set({ title: "Original title" }).where(eq(sessions.id, sessionId))
    await writeTitleChunkForSession(db, sessionId)

    const [original] = await titleChunkRows(sessionId)
    if (!original) throw new Error("no original title chunk")
    await db
      .update(sessionChunk)
      .set({ embedding: Array(1024).fill(0.5) })
      .where(eq(sessionChunk.id, original.id))

    await db.update(sessions).set({ title: "New title" }).where(eq(sessions.id, sessionId))
    await writeTitleChunkForSession(db, sessionId)

    const rows = await titleChunkRows(sessionId)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.id).not.toBe(original.id)
    expect(rows[0]?.searchText).toBe("New title")
    expect(rows[0]?.embedding).toBeNull()
  })
})
