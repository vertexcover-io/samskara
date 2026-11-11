import { eq } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest"
import { createDb, type Db } from "../db/client.js"
import { projects, sessionReviews, sessions, users } from "../db/schema.js"
import { dockerAvailable, startTestDb } from "../db/testDb.js"
import { listReviewsForSession } from "./reviews.repo.js"
import {
  claimReview,
  failReviewAttempt,
  queueReview,
  requeueRunningReviews,
} from "./workQueue.repo.js"

const ANALYZER = "ai-problems-v2"

describe.skipIf(!dockerAvailable())("work queue: reviews", () => {
  let db: Db
  let url: string
  let teardown: () => Promise<void>

  beforeAll(async () => {
    const started = await startTestDb()
    db = started.db
    url = started.url
    teardown = started.teardown
  }, 120_000)

  afterAll(async () => {
    await teardown?.()
  })

  let userId: string
  let projectId: string

  beforeEach(async () => {
    await db.delete(sessionReviews)
    await db.delete(sessions)
    await db.delete(projects)
    await db.delete(users)
    const [user] = await db
      .insert(users)
      .values({ githubId: 4100, githubLogin: "queue-user" })
      .returning({ id: users.id })
    userId = user?.id as string
    const [project] = await db
      .insert(projects)
      .values({ name: "Q", slug: "q", ownerUserId: userId })
      .returning({ id: projects.id })
    projectId = project?.id as string
  })

  const seedSession = async (id: string): Promise<string> => {
    await db.insert(sessions).values({ id, source: "claude_code", userId, projectId, title: id })
    return id
  }

  const seedReview = async (
    sessionId: string,
    values: Partial<typeof sessionReviews.$inferInsert>,
  ) => {
    await seedSession(sessionId)
    const [row] = await db
      .insert(sessionReviews)
      .values({ sessionId, projectId, analyzer: ANALYZER, ...values })
      .returning()
    if (row === undefined) throw new Error("seed review failed")
    return row
  }

  const rowById = async (id: string) => {
    const [row] = await db.select().from(sessionReviews).where(eq(sessionReviews.id, id))
    return row
  }

  const finished = { status: "done", outcome: "productive", summary: "old", signals: {} } as const

  test("SC1: a worker start puts running reviews back to waiting", async () => {
    const a = await seedReview("s-a", { status: "running", attempts: 1 })
    const b = await seedReview("s-b", { status: "running", attempts: 1 })
    const done = await seedReview("s-c", finished)

    expect(await requeueRunningReviews(db)).toBe(2)

    expect(await rowById(a.id)).toMatchObject({ status: "waiting", attempts: 1 })
    expect(await rowById(b.id)).toMatchObject({ status: "waiting", attempts: 1 })
    expect(await rowById(done.id)).toMatchObject({ status: "done", summary: "old" })
  })

  test("a worker start fails a running review that was on its 3rd try instead of trying a 4th", async () => {
    const last = await seedReview("s-last", { status: "running", attempts: 3 })
    const second = await seedReview("s-second", { status: "running", attempts: 2 })

    expect(await requeueRunningReviews(db)).toBe(2)

    expect(await rowById(last.id)).toMatchObject({
      status: "failed",
      attempts: 3,
      error: "harnessFailed: the worker stopped during the last try",
    })
    expect(await rowById(second.id)).toMatchObject({ status: "waiting", attempts: 2 })
  })

  test("SC2: claiming takes the oldest waiting review and counts the try", async () => {
    const middle = await seedReview("s-2", {
      status: "waiting",
      updatedAt: new Date("2026-01-02T00:00:00Z"),
    })
    const oldest = await seedReview("s-1", {
      status: "waiting",
      updatedAt: new Date("2026-01-01T00:00:00Z"),
    })
    const newest = await seedReview("s-3", {
      status: "waiting",
      updatedAt: new Date("2026-01-03T00:00:00Z"),
    })

    const claimed = await claimReview(db)

    expect(claimed).toMatchObject({ id: oldest.id, sessionId: "s-1", attempts: 1 })
    expect(await rowById(oldest.id)).toMatchObject({ status: "running", attempts: 1 })
    expect(await rowById(middle.id)).toMatchObject({ status: "waiting", attempts: 0 })
    expect(await rowById(newest.id)).toMatchObject({ status: "waiting", attempts: 0 })
  })

  test("SC20: a claimed review the nightly pick marked new-part-only carries newPartOnly true", async () => {
    await seedReview("s-20", { ...finished, status: "waiting", newPartOnly: true })

    expect(await claimReview(db)).toMatchObject({ sessionId: "s-20", newPartOnly: true })
  })

  test("SC3: two claimers never take the same row", async () => {
    const ids: string[] = []
    for (let i = 0; i < 5; i += 1) ids.push((await seedReview(`s-${i}`, { status: "waiting" })).id)
    const claimers = Array.from({ length: 10 }, () => createDb(url))
    try {
      const claimed = await Promise.all(claimers.map(({ db: own }) => claimReview(own)))
      const taken = claimed.filter((row) => row !== null).map((row) => row.id)
      expect(taken).toHaveLength(5)
      expect(new Set(taken).size).toBe(5)
      expect([...taken].sort()).toEqual([...ids].sort())
      const rows = await db.select().from(sessionReviews)
      expect(rows.every((row) => row.status === "running" && row.attempts === 1)).toBe(true)
    } finally {
      await Promise.all(claimers.map(({ client }) => client.end()))
    }
  })

  test("SC4: a failed try under 3 goes back to waiting with the reason", async () => {
    const row = await seedReview("s-4", { status: "running", attempts: 1 })

    expect(await failReviewAttempt(db, row.id, "harnessFailed: boom")).toBe("waiting")

    expect(await rowById(row.id)).toMatchObject({
      status: "waiting",
      attempts: 1,
      error: "harnessFailed: boom",
    })
  })

  test("SC5: the 3rd failed try makes the row failed for good", async () => {
    const row = await seedReview("s-5", { status: "running", attempts: 3 })

    expect(await failReviewAttempt(db, row.id, "harnessFailed: boom")).toBe("failed")

    expect(await rowById(row.id)).toMatchObject({ status: "failed", error: "harnessFailed: boom" })
    expect(await claimReview(db)).toBeNull()
  })

  test("SC6: queueing a session with a finished review keeps the old result", async () => {
    const row = await seedReview("s-6", { ...finished, attempts: 2, error: "earlier" })

    const queued = await queueReview(db, {
      sessionId: "s-6",
      projectId,
      analyzer: ANALYZER,
      options: { harness: "claude", model: "opus", prompt: "look for loops" },
    })

    expect(queued).toEqual({ id: row.id })
    expect(await rowById(row.id)).toMatchObject({
      status: "waiting",
      attempts: 0,
      error: null,
      outcome: "productive",
      summary: "old",
      harness: "claude",
      model: "opus",
      prompt: "look for loops",
    })
    const listed = await listReviewsForSession(db, userId, "s-6")
    expect(listed.map((review) => review.summary)).toEqual(["old"])
  })

  test("SC8: the Review button's redo of a row the nightly pick marked new-part-only reads the whole session", async () => {
    const row = await seedReview("s-8", { ...finished, newPartOnly: true })

    const queued = await queueReview(db, {
      sessionId: "s-8",
      projectId,
      analyzer: ANALYZER,
      options: {},
    })

    expect(queued).toEqual({ id: row.id })
    expect(await rowById(row.id)).toMatchObject({
      status: "waiting",
      newPartOnly: false,
      outcome: "productive",
    })
  })

  test("SC6: queueing a session with no review creates a waiting row", async () => {
    await seedSession("s-new")

    const queued = await queueReview(db, {
      sessionId: "s-new",
      projectId,
      analyzer: ANALYZER,
      options: {},
    })

    expect(await rowById(queued?.id as string)).toMatchObject({
      status: "waiting",
      attempts: 0,
      outcome: null,
      harness: null,
      model: null,
      prompt: null,
    })
  })

  test("SC7: queueing a review that is already waiting or running is refused", async () => {
    const row = await seedReview("s-7", { status: "running", attempts: 1, model: "first" })

    const queued = await queueReview(db, {
      sessionId: "s-7",
      projectId,
      analyzer: ANALYZER,
      options: { model: "second" },
    })

    expect(queued).toBeNull()
    expect(await rowById(row.id)).toMatchObject({ status: "running", attempts: 1, model: "first" })
  })
})
