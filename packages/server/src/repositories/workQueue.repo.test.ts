import { eq, sql } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest"
import { createDb, type Db } from "../db/client.js"
import { projects, reviewReaderReplies, sessionReviews, sessions, users } from "../db/schema.js"
import { dockerAvailable, startTestDb } from "../db/testDb.js"
import { saveReaderReply } from "./readerReplies.repo.js"
import { listReviewsForSession } from "./reviews.repo.js"
import {
  claimReview,
  failReviewAttempt,
  queueReview,
  requeueRunningReviews,
  unfinishedReview,
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

  test("a worker start fails a running review on the configured last try", async () => {
    const second = await seedReview("s-second", { status: "running", attempts: 2 })

    expect(await requeueRunningReviews(db, [], 2)).toBe(1)

    expect(await rowById(second.id)).toMatchObject({ status: "failed", attempts: 2 })
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

  test("SC2: queueing a session with a done review adds a new waiting row and leaves the done one untouched", async () => {
    const row = await seedReview("s-6", { ...finished, attempts: 2 })

    const queued = await queueReview(db, {
      sessionId: "s-6",
      projectId,
      analyzer: ANALYZER,
      options: { harness: "claude", model: "opus", prompt: "look for loops" },
    })

    expect(queued?.id).not.toBe(row.id)
    expect(await rowById(row.id)).toEqual(row)
    expect(await rowById(queued?.id as string)).toMatchObject({
      status: "waiting",
      attempts: 0,
      outcome: null,
      harness: "claude",
      model: "opus",
      prompt: "look for loops",
      newPartOnly: false,
      basedOn: null,
    })
    const listed = await listReviewsForSession(db, userId, "s-6")
    expect(listed.map((review) => review.summary)).toEqual(["old"])
  })

  test("SC3: a second run is refused while one is waiting, and accepted once that run is done", async () => {
    const waiting = await seedReview("s-one", { status: "waiting" })
    const input = { sessionId: "s-one", projectId, analyzer: ANALYZER, options: {} }

    expect(await queueReview(db, input)).toBeNull()
    expect(await db.select().from(sessionReviews)).toHaveLength(1)

    await db
      .update(sessionReviews)
      .set({ ...finished })
      .where(eq(sessionReviews.id, waiting.id))
    const next = await queueReview(db, input)

    expect(next).not.toBeNull()
    expect(await db.select().from(sessionReviews)).toHaveLength(2)
  })

  test("SC4: a failed try is retried on the same row, and after the 3rd a new queue adds a different row", async () => {
    await seedSession("s-retry")
    const input = { sessionId: "s-retry", projectId, analyzer: ANALYZER, options: {} }
    const queued = await queueReview(db, input)
    const id = queued?.id as string

    for (const attempt of [1, 2, 3]) {
      const claimed = await claimReview(db)
      expect(claimed).toMatchObject({ id, attempts: attempt })
      await failReviewAttempt(db, id, "harnessFailed: boom")
    }

    expect(await rowById(id)).toMatchObject({ status: "failed", attempts: 3 })
    const again = await queueReview(db, input)
    expect(again?.id).toBeDefined()
    expect(again?.id).not.toBe(id)
  })

  test("a claimed new-part run says it reads only the new part and which run it continues from", async () => {
    const base = await seedReview("s-part", finished)
    await queueReview(db, {
      sessionId: "s-part",
      projectId,
      analyzer: ANALYZER,
      options: {},
      basedOn: base.id,
    })

    expect(await claimReview(db)).toMatchObject({ newPartOnly: true, basedOn: base.id })
  })

  test("a failed run shows as the job only while it is the newest run; a done run after it ends it", async () => {
    await seedSession("s-job")
    const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 10, minute))
    const insert = (values: Partial<typeof sessionReviews.$inferInsert>) =>
      db
        .insert(sessionReviews)
        .values({ sessionId: "s-job", projectId, analyzer: ANALYZER, ...values })

    await insert({ ...finished, createdAt: at(1) })
    await insert({ status: "failed", error: "harnessFailed: boom", createdAt: at(2) })
    expect(await unfinishedReview(db, "s-job", ANALYZER)).toMatchObject({ status: "failed" })

    await insert({ ...finished, createdAt: at(3) })
    expect(await unfinishedReview(db, "s-job", ANALYZER)).toBeNull()
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

  describe("saved reader replies", () => {
    /** A review row holding one saved reader reply, as a try that read one piece leaves it. */
    const seedWithReply = async (
      sessionId: string,
      values: Partial<typeof sessionReviews.$inferInsert>,
    ) => {
      const row = await seedReview(sessionId, values)
      await saveReaderReply(db, { reviewId: row.id, pieceHash: "piece-1", reply: "Nothing found." })
      return row
    }

    const repliesOf = async (reviewId: string) =>
      db.select().from(reviewReaderReplies).where(eq(reviewReaderReplies.reviewId, reviewId))

    test("SC411: the 3rd failed try removes the review's replies; an earlier failed try keeps them", async () => {
      const last = await seedWithReply("s-last", { status: "running", attempts: 3 })
      const early = await seedWithReply("s-early", { status: "running", attempts: 1 })

      expect(await failReviewAttempt(db, last.id, "harnessFailed: boom")).toBe("failed")
      expect(await failReviewAttempt(db, early.id, "harnessFailed: boom")).toBe("waiting")

      expect(await repliesOf(last.id)).toEqual([])
      expect(await repliesOf(early.id)).toHaveLength(1)
    })

    test("SC412: a worker start that fails a review on its 3rd try removes its replies; one going back to waiting keeps them", async () => {
      const last = await seedWithReply("s-last", { status: "running", attempts: 3 })
      const second = await seedWithReply("s-second", { status: "running", attempts: 2 })

      expect(await requeueRunningReviews(db)).toBe(2)

      expect(await rowById(last.id)).toMatchObject({ status: "failed" })
      expect(await repliesOf(last.id)).toEqual([])
      expect(await rowById(second.id)).toMatchObject({ status: "waiting" })
      expect(await repliesOf(second.id)).toHaveLength(1)
    })

    test("SC414: when the replies cannot be deleted, a 3rd failed try and a restart both leave the row running rather than failed with its replies behind", async () => {
      const failing = await seedWithReply("s-failing", { status: "running", attempts: 3 })
      await db.execute(sql`
        create function "refuseDelete"() returns trigger language plpgsql
        as $$ begin raise exception 'delete refused'; end $$`)
      await db.execute(sql`
        create trigger "refuseDelete" before delete on "reviewReaderReplies"
        for each row execute function "refuseDelete"()`)
      try {
        await expect(failReviewAttempt(db, failing.id, "harnessFailed: boom")).rejects.toThrow()
        expect(await rowById(failing.id)).toMatchObject({ status: "running" })

        await expect(requeueRunningReviews(db)).rejects.toThrow()
        expect(await rowById(failing.id)).toMatchObject({ status: "running" })
        expect(await repliesOf(failing.id)).toHaveLength(1)
      } finally {
        await db.execute(sql`drop trigger "refuseDelete" on "reviewReaderReplies"`)
        await db.execute(sql`drop function "refuseDelete"()`)
      }
    })

    test("SC413: claiming a retry keeps the replies its earlier tries saved", async () => {
      const retry = await seedWithReply("s-retry", { status: "waiting", attempts: 1 })

      expect(await claimReview(db)).toMatchObject({ id: retry.id, attempts: 2 })
      expect(await repliesOf(retry.id)).toHaveLength(1)
    })
  })
})
