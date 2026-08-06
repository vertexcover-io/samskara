import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { type Db, createDb } from "../db/client.js"
import { messages, sessionChunk, sessions, users } from "../db/schema.js"
import type { EmbeddingClient } from "../search/embedding.js"
import { unconfiguredEmbeddingClient } from "../search/embedding.js"
import * as projectsRepo from "./projects.repo.js"
import { searchSessions } from "./search.repo.js"
import { writeChunksForSession, writeTitleChunkForSession } from "./sessionChunks.repo.js"

const zeroVector = (): ReadonlyArray<number> => Array(1024).fill(0)

/** A client whose query embedding always equals `target`, regardless of the string asked. */
const clientReturning = (target: ReadonlyArray<number>): EmbeddingClient => ({
  embedDocuments: async (texts) => texts.map(() => zeroVector()),
  embedQuery: async () => target,
})

const dockerAvailable = () => {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

const packageDir = fileURLToPath(new URL("../..", import.meta.url))

describe.skipIf(!dockerAvailable())("searchSessions", () => {
  let container: StartedPostgreSqlContainer
  let teardown: () => Promise<void>
  let db: Db

  let counter = 0
  const seedUser = async (login = "search-user") => {
    counter += 1
    const [user] = await db
      .insert(users)
      .values({ githubId: 8000 + counter, githubLogin: `${login}-${counter}` })
      .returning()
    if (!user) throw new Error("seed user failed")
    return user
  }

  const seedSession = async (id: string, userId: string, title?: string) => {
    const projectId = await projectsRepo.upsert(db, {
      identity: { name: id, slug: `slug-${id}` },
      ownerId: userId,
    })
    await db.insert(sessions).values({ id, source: "claude_code", userId, projectId, title })
    return projectId
  }

  const insertTurn = async (
    sessionId: string,
    text: string,
    lineNumbers: readonly [number, number],
  ) => {
    await db.insert(messages).values({
      sessionId,
      lineUuid: crypto.randomUUID(),
      subIndex: 0,
      msgType: "message",
      role: "user",
      lineNumber: lineNumbers[0],
      content: { type: "text", value: text },
      raw: {},
      sourceSchemaVersion: 1,
    })
    // Closes the previous turn.
    await db.insert(messages).values({
      sessionId,
      lineUuid: crypto.randomUUID(),
      subIndex: 0,
      msgType: "message",
      role: "user",
      lineNumber: lineNumbers[1],
      raw: {},
      sourceSchemaVersion: 1,
    })
    await writeChunksForSession(db, sessionId)
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

  test("D8: sessions rank by keyword relevance -- the order is asserted, not merely membership", async () => {
    const owner = await seedUser()
    await seedSession("sess-strong-match", owner.id)
    await seedSession("sess-weak-match", owner.id)
    await seedSession("sess-no-match", owner.id)

    // The strong match repeats "memory leak" (higher ts_rank_cd), the weak match mentions it once
    // among unrelated prose, and the third session never mentions it at all.
    await insertTurn(
      "sess-strong-match",
      "memory leak memory leak investigate the memory leak in the worker",
      [1, 2],
    )
    await insertTurn(
      "sess-weak-match",
      "quick fix for a memory leak, then move on to styling",
      [1, 2],
    )
    await insertTurn("sess-no-match", "refactor the CSS build pipeline", [1, 2])

    const results = await searchSessions(
      db,
      owner.id,
      "memory leak",
      unconfiguredEmbeddingClient,
      {},
    )

    expect(results.map((r) => r.id)).toEqual(["sess-strong-match", "sess-weak-match"])
  })

  test("D20: a second user's strongly matching session never appears, however strongly it matches", async () => {
    const owner = await seedUser("scope-owner")
    const stranger = await seedUser("scope-stranger")
    await seedSession("sess-owner-visible", owner.id)
    await seedSession("sess-stranger-hidden", stranger.id)

    await insertTurn("sess-owner-visible", "debugging the flaky retry logic", [1, 2])
    await insertTurn(
      "sess-stranger-hidden",
      "flaky retry logic flaky retry logic flaky retry logic",
      [1, 2],
    )

    const results = await searchSessions(
      db,
      owner.id,
      "flaky retry logic",
      unconfiguredEmbeddingClient,
      {},
    )

    expect(results.map((r) => r.id)).toEqual(["sess-owner-visible"])
  })

  test("a query matching nothing returns an empty list", async () => {
    const owner = await seedUser("empty-owner")
    await seedSession("sess-empty-query", owner.id)
    await insertTurn("sess-empty-query", "totally unrelated content", [1, 2])

    expect(
      await searchSessions(db, owner.id, "xenomorphic quasar", unconfiguredEmbeddingClient, {}),
    ).toEqual([])
  })

  test("a query matching nothing returns an empty list even when every chunk is embedded", async () => {
    // The sibling test above passes an embedder that throws, so the vector list is empty and only
    // the keyword list decides. That is what let an unbounded vector list ship: with a *working*
    // embedder the same query returned every readable session, ranked by cosine noise.
    const owner = await seedUser("embedded-empty-owner")
    await seedSession("sess-embedded-a", owner.id)
    await seedSession("sess-embedded-b", owner.id)
    await insertTurn("sess-embedded-a", "totally unrelated content about styling", [1, 2])
    await insertTurn("sess-embedded-b", "more unrelated content about packaging", [1, 2])

    // Every chunk carries a vector orthogonal to the query's (cosine distance 1.0), which is what
    // "not related" looks like -- far, but a perfectly valid row the ranker will happily return.
    const chunkVector = Array.from({ length: 1024 }, (_, i) => (i === 1 ? 1 : 0))
    const queryVector = Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0))
    await db.update(sessionChunk).set({ embedding: chunkVector })

    const results = await searchSessions(
      db,
      owner.id,
      "xenomorphic quasar",
      clientReturning(queryVector),
      {},
    )

    expect(results.map((r) => r.id)).toEqual([])
  })

  test("a distant-but-embedded session does not displace a genuine keyword match", async () => {
    const owner = await seedUser("floor-owner")
    await seedSession("sess-real-hit", owner.id)
    await seedSession("sess-far-noise", owner.id)
    await insertTurn("sess-real-hit", "the memory leak in the worker", [1, 2])
    await insertTurn("sess-far-noise", "unrelated packaging notes", [1, 2])

    const chunkVector = Array.from({ length: 1024 }, (_, i) => (i === 1 ? 1 : 0))
    const queryVector = Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0))
    await db.update(sessionChunk).set({ embedding: chunkVector })

    const results = await searchSessions(
      db,
      owner.id,
      "memory leak",
      clientReturning(queryVector),
      {},
    )

    expect(results.map((r) => r.id)).toEqual(["sess-real-hit"])
  })

  test("the winning chunk's snippet and anchor are carried on the result row", async () => {
    const owner = await seedUser("snippet-owner")
    await seedSession("sess-snippet", owner.id)
    await insertTurn("sess-snippet", "investigating the login timeout bug", [1, 2])

    const [result] = await searchSessions(
      db,
      owner.id,
      "login timeout",
      unconfiguredEmbeddingClient,
      {},
    )

    expect(result?.snippet).toBeTruthy()
    expect(result?.anchorMessageId).toBeTruthy()
    // The matched terms are delimited with STX/ETX so the client can mark them without any
    // server-built markup crossing the wire. Asserting here rather than in a unit test because
    // `ts_headline`'s option string is bound as a query parameter -- only a real query proves it
    // reaches Postgres as control characters rather than as the literal text "\u0002".
    expect(result?.snippet).toContain("\u0002")
    expect(result?.snippet).toContain("\u0003")
    // No `<b>` match markup: the snippet renders as plain text client-side, and searchText can
    // carry arbitrary tool-result content, so emitting HTML here would be an injection risk.
    expect(result?.snippet).not.toContain("<b>")
  })

  test("D18: a query sharing no keyword with a session still ranks it, via the vector list", async () => {
    const owner = await seedUser("vector-only-owner")
    await seedSession("sess-vector-only", owner.id)
    await seedSession("sess-unrelated", owner.id)
    await insertTurn("sess-vector-only", "the deployment pipeline needs a review", [1, 2])
    await insertTurn("sess-unrelated", "completely unrelated filler content", [1, 2])

    const targetVector = Array.from({ length: 1024 }, (_, i) => (i % 3) - 1)
    await db
      .update(sessionChunk)
      .set({ embedding: targetVector })
      .where(eq(sessionChunk.sessionId, "sess-vector-only"))

    const results = await searchSessions(
      db,
      owner.id,
      "xenoglossic quasar phenomenon",
      clientReturning(targetVector),
      {},
    )

    expect(results.map((r) => r.id)).toEqual(["sess-vector-only"])
  })

  test("fusion order differs from keyword-only order for the same corpus", async () => {
    const owner = await seedUser("fusion-order-owner")
    await seedSession("sess-kw-first", owner.id)
    await seedSession("sess-vec-first", owner.id)
    await insertTurn("sess-kw-first", "outage outage outage outage root cause found", [1, 2])
    await insertTurn("sess-vec-first", "a brief mention of the outage", [1, 2])

    const targetVector = Array.from({ length: 1024 }, (_, i) => (i % 5) - 2)
    await db
      .update(sessionChunk)
      .set({ embedding: targetVector })
      .where(eq(sessionChunk.sessionId, "sess-vec-first"))

    const keywordOnly = await searchSessions(
      db,
      owner.id,
      "outage",
      unconfiguredEmbeddingClient,
      {},
    )
    expect(keywordOnly.map((r) => r.id)).toEqual(["sess-kw-first", "sess-vec-first"])

    const fused = await searchSessions(db, owner.id, "outage", clientReturning(targetVector), {})
    expect(fused.map((r) => r.id)).toEqual(["sess-vec-first", "sess-kw-first"])
  })

  test("D15: a titled session ranks above an identical untitled one for a title-matching query", async () => {
    const owner = await seedUser("title-rank-owner")
    await seedSession("sess-untitled", owner.id)
    await seedSession("sess-titled", owner.id, "Outage investigation")
    await insertTurn("sess-untitled", "outage outage outage was resolved quickly", [1, 2])
    await insertTurn("sess-titled", "outage was resolved quickly", [1, 2])
    await writeTitleChunkForSession(db, "sess-titled")

    const results = await searchSessions(db, owner.id, "outage", unconfiguredEmbeddingClient, {})

    expect(results.map((r) => r.id)).toEqual(["sess-titled", "sess-untitled"])
  })

  test("D21: a throwing embedder degrades to keyword-ranked results rather than failing the request", async () => {
    const owner = await seedUser("degrade-owner")
    await seedSession("sess-degrade", owner.id)
    await insertTurn("sess-degrade", "database connection pool exhausted", [1, 2])

    const throwingClient: EmbeddingClient = {
      embedDocuments: async () => {
        throw new Error("provider unreachable")
      },
      embedQuery: async () => {
        throw new Error("provider unreachable")
      },
    }

    const results = await searchSessions(db, owner.id, "connection pool", throwingClient, {})

    expect(results.map((r) => r.id)).toEqual(["sess-degrade"])
  })
})
