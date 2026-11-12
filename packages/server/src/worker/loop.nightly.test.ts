import { createLogger } from "@samskara/core"
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest"
import type { Db } from "../db/client.js"
import {
  projects,
  pullRequests,
  repos,
  sessionPullRequests,
  sessionReviews,
  sessions,
  users,
} from "../db/schema.js"
import { dockerAvailable, startTestDb } from "../db/testDb.js"
import type { NightlyReview } from "../lib/env.js"
import { captureLogger } from "../lib/test-logger.js"
import { finishReview } from "../repositories/reviews.repo.js"
import type { ClaimedReview } from "../repositories/workQueue.repo.js"
import type { AiReviewResult } from "../services/ai-review/pipeline.js"
import type { PullRequestLookup } from "../services/pullRequestStates.js"
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
    const saved = await finishReview(db, review.id, {
      outcome: "productive",
      summary: "ok",
      signals: {},
      lastMessageId: null,
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
  describe("pull request states before the pick", () => {
    const NO_TOKEN =
      "no LEARNINGS_HARNESS_GITHUB_TOKEN: the nightly pick will not read pull request states"

    /** A session whose last message was an hour before `now`, so not yet quiet for 6 hours. */
    const busySession = async (now: Date): Promise<string> => {
      counter += 1
      const id = `loop-nightly-${counter}`
      const at = new Date(now.getTime() - HOUR_MS)
      await db.insert(sessions).values({
        id,
        source: "claude_code",
        userId,
        projectId,
        lastMessageAt: at,
        updatedAt: at,
      })
      return id
    }

    /** An open github.com pull request the session opened. */
    const openPullRequest = async (sessionId: string): Promise<string> => {
      counter += 1
      const [repo] = await db
        .insert(repos)
        .values({
          host: "github.com",
          owner: "acme",
          repoName: `app-${counter}`,
          ownerUserId: userId,
        })
        .returning({ id: repos.id })
      const [pr] = await db
        .insert(pullRequests)
        .values({ repoId: repo?.id as string, number: counter })
        .returning({ id: pullRequests.id })
      await db.insert(sessionPullRequests).values({ sessionId, prId: pr?.id as string })
      return pr?.id as string
    }

    const prRow = async (id: string) => {
      const [row] = await db.select().from(pullRequests).where(eq(pullRequests.id, id))
      return row
    }

    test("SC15: a due tick saves GitHub's answer and queues the merged session", async () => {
      const now = ist(2)
      const merged = await busySession(now)
      const prId = await openPullRequest(merged)
      const mergedAt = new Date(now.getTime() - 30 * 60 * 1000)
      const lookup = vi.fn<PullRequestLookup>(async (prs) => ({
        answers: prs.map((pr) => ({ id: pr.id, state: "merged" as const, closedAt: mergedAt })),
        failures: [],
      }))
      const loop = loopAt(now, { pullRequestLookup: lookup })

      await loop.tick()
      await loop.idle()

      expect(lookup).toHaveBeenCalledTimes(1)
      expect(await prRow(prId)).toMatchObject({
        state: "merged",
        closedAt: mergedAt,
        checkedAt: now,
      })
      const all = await rows()
      expect(all.map((row) => row.sessionId)).toEqual([merged])
      expect(all[0]?.status).toBe("done")
    })

    test("SC16: a pull request GitHub still reports open leaves its session waiting", async () => {
      const now = ist(2)
      const busy = await busySession(now)
      const prId = await openPullRequest(busy)
      const quiet = await readySession()
      const lookup: PullRequestLookup = async (prs) => ({
        answers: prs.map((pr) => ({ id: pr.id, state: "open" as const, closedAt: null })),
        failures: [],
      })
      const loop = loopAt(now, { pullRequestLookup: lookup })

      await loop.tick()
      await loop.idle()

      expect((await rows()).map((row) => row.sessionId)).toEqual([quiet])
      expect(await prRow(prId)).toMatchObject({ state: "open", closedAt: null, checkedAt: now })
    })

    test("SC17: without a token the pick runs on the 6-hour rule and says so once", async () => {
      const now = ist(2)
      const quiet = await readySession()
      const busy = await busySession(now)
      await openPullRequest(busy)
      const captured = captureLogger()
      const loop = loopAt(now, { log: captured.log })

      await loop.tick()
      await loop.idle()
      await loop.tick()
      await loop.idle()

      expect((await rows()).map((row) => row.sessionId)).toEqual([quiet])
      expect(captured.lines.filter((line) => line.msg === NO_TOKEN)).toHaveLength(1)
    })

    test.each([
      {
        label: "reports a failed request",
        lookup: (async () => ({ answers: [], failures: ["boom"] })) satisfies PullRequestLookup,
      },
      {
        label: "rejects",
        lookup: (async () => {
          throw new Error("network down")
        }) satisfies PullRequestLookup,
      },
    ])("SC18: a GitHub lookup that $label does not stop the pick", async ({ lookup }) => {
      const now = ist(2)
      const quiet = await readySession()
      const busy = await busySession(now)
      const prId = await openPullRequest(busy)
      const before = await prRow(prId)
      const captured = captureLogger()
      const loop = loopAt(now, { log: captured.log, pullRequestLookup: lookup })

      await loop.tick()
      await loop.idle()

      const all = await rows()
      expect(all.map((row) => row.sessionId)).toEqual([quiet])
      expect(all[0]?.status).toBe("done")
      expect(await prRow(prId)).toEqual(before)
      expect(captured.at("warn").length).toBeGreaterThan(0)
    })

    test("SC18: a request that fails does not cost the answers the other requests got", async () => {
      const now = ist(2)
      const merged = await busySession(now)
      const prId = await openPullRequest(merged)
      const mergedAt = new Date(now.getTime() - 30 * 60 * 1000)
      const lookup: PullRequestLookup = async (prs) => ({
        answers: prs.map((pr) => ({ id: pr.id, state: "merged" as const, closedAt: mergedAt })),
        failures: ["github pull request check failed (502)"],
      })
      const captured = captureLogger()
      const loop = loopAt(now, { log: captured.log, pullRequestLookup: lookup })

      await loop.tick()
      await loop.idle()

      expect(await prRow(prId)).toMatchObject({ state: "merged", closedAt: mergedAt })
      const all = await rows()
      expect(all.map((row) => row.sessionId)).toEqual([merged])
      expect(all[0]?.status).toBe("done")
      expect(captured.at("warn").length).toBeGreaterThan(0)
    })

    test("SC19: no GitHub call outside the due minute", async () => {
      await db
        .update(projects)
        .set({ lastNightlyPickAt: ist(2) })
        .where(eq(projects.id, projectId))
      const now = ist(23)
      await openPullRequest(await busySession(now))
      await readySession()
      const lookup = vi.fn<PullRequestLookup>(async () => ({ answers: [], failures: [] }))
      const loop = loopAt(now, { pullRequestLookup: lookup })

      await loop.tick()
      await loop.idle()

      expect(lookup).not.toHaveBeenCalled()
      expect(await rows()).toHaveLength(0)
    })
  })
})
