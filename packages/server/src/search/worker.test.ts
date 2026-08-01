import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import { asc, eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { type Db, createDb } from "../db/client.js"
import { sessionChunk, sessions, users } from "../db/schema.js"
import * as projectsRepo from "../repositories/projects.repo.js"
import { EMBEDDING_LEASE_MINUTES, EMBEDDING_MAX_ATTEMPTS } from "./constants.js"
import { createFakeEmbeddingClient } from "./fakeEmbedding.js"
import { runEmbeddingBatch, startEmbeddingWorker } from "./worker.js"

const dockerAvailable = () => {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

const packageDir = fileURLToPath(new URL("../..", import.meta.url))

describe.skipIf(!dockerAvailable())("embedding worker", () => {
  let container: StartedPostgreSqlContainer
  let teardown: () => Promise<void>
  let db: Db

  let counter = 0
  const seedSession = async (id: string): Promise<void> => {
    counter += 1
    const [user] = await db
      .insert(users)
      .values({ githubId: 500 + counter, githubLogin: `worker-user-${counter}` })
      .returning()
    if (!user) throw new Error("seed user failed")
    const projectId = await projectsRepo.upsert(db, {
      identity: { name: id, slug: `slug-${id}` },
      ownerId: user.id,
    })
    await db.insert(sessions).values({ id, source: "claude_code", userId: user.id, projectId })
  }

  const insertChunk = async (
    sessionId: string,
    partIndex: number,
    overrides: Partial<typeof sessionChunk.$inferInsert> = {},
  ): Promise<string> => {
    const [row] = await db
      .insert(sessionChunk)
      .values({
        sessionId,
        kind: "turn",
        partIndex,
        searchText: `chunk ${partIndex}`,
        embedText: `chunk ${partIndex}`,
        embedding: null,
        ...overrides,
      })
      .returning({ id: sessionChunk.id })
    if (!row) throw new Error("no seeded chunk")
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

  test("D12: a batch claims only rows with a null embedding and fills them", async () => {
    const sessionId = "sess-worker-basic"
    await seedSession(sessionId)
    await insertChunk(sessionId, 0)
    await insertChunk(sessionId, 1, { embedding: Array(1024).fill(0) })

    const result = await runEmbeddingBatch(db, createFakeEmbeddingClient(), 10)

    expect(result).toEqual({ claimed: 1, embedded: 1, failed: 0 })
    const rows = await db
      .select({ partIndex: sessionChunk.partIndex, embedding: sessionChunk.embedding })
      .from(sessionChunk)
      .where(eq(sessionChunk.sessionId, sessionId))
      .orderBy(asc(sessionChunk.partIndex))
    expect(rows[0]?.embedding).not.toBeNull()
    expect(rows[1]?.embedding).toEqual(Array(1024).fill(0))
  })

  test("D12: two concurrent workers claiming the same batch embed no row twice", async () => {
    const sessionId = "sess-worker-concurrent"
    await seedSession(sessionId)
    for (let i = 0; i < 6; i += 1) await insertChunk(sessionId, i)

    const client = createFakeEmbeddingClient()
    const [a, b] = await Promise.all([
      runEmbeddingBatch(db, client, 10),
      runEmbeddingBatch(db, client, 10),
    ])

    expect(a.claimed + b.claimed).toBe(6)
    const rows = await db
      .select({ attempts: sessionChunk.attempts, embedding: sessionChunk.embedding })
      .from(sessionChunk)
      .where(eq(sessionChunk.sessionId, sessionId))
    expect(rows.every((r) => r.attempts === 1)).toBe(true)
    expect(rows.every((r) => r.embedding !== null)).toBe(true)
  })

  test("D12: a row whose lease expired is re-claimed and its attempts increments again", async () => {
    const sessionId = "sess-worker-lease"
    await seedSession(sessionId)
    const expiredLease = new Date(Date.now() - (EMBEDDING_LEASE_MINUTES + 1) * 60_000)
    const chunkId = await insertChunk(sessionId, 0, { claimedAt: expiredLease, attempts: 1 })

    const result = await runEmbeddingBatch(db, createFakeEmbeddingClient(), 10)

    expect(result.claimed).toBe(1)
    const [row] = await db.select().from(sessionChunk).where(eq(sessionChunk.id, chunkId))
    expect(row?.attempts).toBe(2)
    expect(row?.embedding).not.toBeNull()
  })

  test("D12: a row at maxAttempts is skipped rather than retried forever", async () => {
    const sessionId = "sess-worker-exhausted"
    await seedSession(sessionId)
    await insertChunk(sessionId, 0, { attempts: EMBEDDING_MAX_ATTEMPTS })

    const result = await runEmbeddingBatch(db, createFakeEmbeddingClient(), 10)

    expect(result.claimed).toBe(0)
  })

  test("startEmbeddingWorker polls on its interval and stop() halts further polling", async () => {
    const sessionId = "sess-worker-poll"
    await seedSession(sessionId)
    await insertChunk(sessionId, 0)

    const handle = startEmbeddingWorker({
      db,
      client: createFakeEmbeddingClient(),
      intervalMs: 20,
      limit: 10,
    })
    await new Promise((resolve) => setTimeout(resolve, 150))
    handle.stop()

    const [embeddedRow] = await db
      .select({ embedding: sessionChunk.embedding })
      .from(sessionChunk)
      .where(eq(sessionChunk.sessionId, sessionId))
    expect(embeddedRow?.embedding).not.toBeNull()

    const laterChunkId = await insertChunk(sessionId, 1)
    await new Promise((resolve) => setTimeout(resolve, 100))

    const [afterStop] = await db
      .select()
      .from(sessionChunk)
      .where(eq(sessionChunk.id, laterChunkId))
    expect(afterStop?.embedding).toBeNull()
  })
})
