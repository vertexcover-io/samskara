import { createLogger } from "@samskara/core"
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest"
import type { Db } from "../db/client.js"
import { projects, sessionReviews, sessions, users } from "../db/schema.js"
import { dockerAvailable, startTestDb } from "../db/testDb.js"
import type { NightlyReview } from "../lib/env.js"
import { captureLogger } from "../lib/test-logger.js"
import { upsertReview } from "../repositories/reviews.repo.js"
import type { ClaimedReview } from "../repositories/workQueue.repo.js"
import type { AiReviewResult } from "../services/ai-review/pipeline.js"
import { createWorkLoop, type WorkLoopDeps } from "./loop.js"

const ANALYZER = "ai-problems-v2"
const HOUR_MS = 60 * 60 * 1000
const log = createLogger({ service: "loop-nightly-test", level: "silent" })
const NIGHTLY: NightlyReview = { at: "01:00", timeZone: "Asia/Kolkata", limit: 10 }

/** An instant given as India wall-clock time on 11 November 2026. */
const ist = (hour: number, minute = 0): Date =>
  new Date(Date.UTC(2026, 10, 11, hour, minute) - 5.5 * HOUR_MS)

describe.skipIf(!dockerAvailable())("work loop: the nightly pick", () => {
  let db: Db
  let teardown: () => Promise<void>
  let userId: string
  let projectId: string
  let counter = 0

  beforeAll(async () => {
    const started = await startTestDb()
    db = started.db
    teardown = started.teardown
  }, 120_000)

  afterAll(async () => {
    await teardown?.()
  })

  beforeEach(async () => {
    await db.delete(sessionReviews)
    await db.delete(sessions)
    await db.delete(projects)
    await db.delete(users)
    const [user] = await db
      .insert(users)
      .values({ githubId: 4700, githubLogin: "loop-nightly-user" })
      .returning({ id: users.id })
    userId = user?.id as string
    const [project] = await db
      .insert(projects)
      .values({ name: "LN", slug: "ln", ownerUserId: userId, autoReview: true })
      .returning({ id: projects.id })
    projectId = project?.id as string
  })

  /** A session last active well before any `now` these tests use. */
  const readySession = async (): Promise<string> => {
    counter += 1
    const id = `loop-nightly-${counter}`
    const quietSince = new Date(ist(0).getTime() - 12 * HOUR_MS)
    await db.insert(sessions).values({
      id,
      source: "claude_code",
      userId,
      projectId,
      lastMessageAt: quietSince,
      updatedAt: quietSince,
    })
    return id
  }

  const rows = () => db.select().from(sessionReviews)

  const lastPick = async (): Promise<Date | null> => {
    const [row] = await db
      .select({ at: projects.lastNightlyPickAt })
      .from(projects)
      .where(eq(projects.id, projectId))
    return row?.at ?? null
  }

  /** What runAiReview's success does to the row: saves the result as done. */
  const succeed = async (review: ClaimedReview): Promise<AiReviewResult> => {
    const saved = await upsertReview(db, {
      sessionId: review.sessionId,
      projectId,
      analyzer: ANALYZER,
      outcome: "productive",
      summary: "ok",
      signals: {},
      reviewedThrough: null,
    })
    return { kind: "ok", reviewId: saved.id, review: {} as never }
  }

  const loopAt = (now: Date, overrides: Partial<WorkLoopDeps> = {}) =>
    createWorkLoop({
      db,
      log,
      runReview: succeed,
      nightlyReview: NIGHTLY,
      now: () => now,
      ...overrides,
    })

  test("SC10: a missed 1:00 am is caught up when the worker starts", async () => {
    const ids = [await readySession(), await readySession()]
    const ran: string[] = []
    const loop = loopAt(ist(9), {
      runReview: async (review) => {
        ran.push(review.sessionId)
        return succeed(review)
      },
    })

    await loop.tick()
    await loop.idle()

    expect((await rows()).map((row) => row.sessionId).sort()).toEqual([...ids].sort())
    expect([...ran].sort()).toEqual([...ids].sort())
    expect(await lastPick()).toEqual(ist(9))
  })

  test("SC11: a restarted worker does not pick again the same day", async () => {
    await readySession()
    await readySession()
    const first = loopAt(ist(9))
    await first.tick()
    await first.idle()
    first.stop()

    const added = await readySession()
    const restarted = loopAt(ist(9, 30))
    await restarted.tick()
    await restarted.idle()

    const reviewed = (await rows()).map((row) => row.sessionId)
    expect(reviewed).toHaveLength(2)
    expect(reviewed).not.toContain(added)
    expect(await lastPick()).toEqual(ist(9))
  })

  test("SC12: picked rows are run by the worker, at most 2 at once, and end done", async () => {
    for (let i = 0; i < 3; i += 1) await readySession()
    let running = 0
    let most = 0
    const loop = loopAt(ist(2), {
      reviewSlots: 2,
      runReview: async (review) => {
        running += 1
        most = Math.max(most, running)
        await new Promise((resolve) => setTimeout(resolve, 20))
        try {
          return await succeed(review)
        } finally {
          running -= 1
        }
      },
    })

    await loop.tick()
    await loop.idle()

    const all = await rows()
    expect(all).toHaveLength(3)
    for (const row of all) expect(row).toMatchObject({ status: "done", summary: "ok" })
    expect(most).toBe(2)
  })

  test("SC13: a failing pick is logged and the claims go on", async () => {
    const waiting = await readySession()
    await db
      .insert(sessionReviews)
      .values({ sessionId: waiting, projectId, analyzer: ANALYZER, status: "waiting" })
    await readySession()
    const captured = captureLogger()
    const loop = loopAt(ist(2), {
      log: captured.log,
      nightlyReview: { ...NIGHTLY, timeZone: "Mars/Base" },
    })

    await loop.tick()
    await loop.idle()

    const all = await rows()
    expect(all).toHaveLength(1)
    expect(all[0]).toMatchObject({ sessionId: waiting, status: "done" })
    expect(captured.at("error").map((line) => line.msg)).toContain(
      "nightly pick failed; claiming what is already waiting",
    )
  })

  test("SC14: a loop with no nightly settings picks nothing", async () => {
    await readySession()
    const loop = createWorkLoop({ db, log, runReview: succeed, now: () => ist(2) })

    await loop.tick()
    await loop.idle()

    expect(await rows()).toHaveLength(0)
    expect(await lastPick()).toBeNull()
  })
})
