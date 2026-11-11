import { eq, sql } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest"
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
import { insertOpened } from "./pullRequests.repo.js"
import { queueNightlyReviews } from "./workQueue.repo.js"

const ANALYZER = "ai-problems-v2"
const HOUR_MS = 60 * 60 * 1000
const IST_OFFSET_MS = 5.5 * HOUR_MS

/** An instant given as India wall-clock time in November 2026. */
const ist = (day: number, hour: number, minute = 0): Date =>
  new Date(Date.UTC(2026, 10, day, hour, minute) - IST_OFFSET_MS)

const hoursBefore = (at: Date, hours: number): Date => new Date(at.getTime() - hours * HOUR_MS)

const DEFAULTS = { at: "01:00", timeZone: "Asia/Kolkata", limit: 10, analyzer: ANALYZER } as const

describe.skipIf(!dockerAvailable())("work queue: the nightly pick", () => {
  let db: Db
  let teardown: () => Promise<void>
  let userId: string
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
      .values({ githubId: 4600, githubLogin: "nightly-user" })
      .returning({ id: users.id })
    userId = user?.id as string
  })

  const project = async (
    values: { autoReview?: boolean; lastNightlyPickAt?: Date } = {},
  ): Promise<string> => {
    counter += 1
    const [row] = await db
      .insert(projects)
      .values({ name: `N${counter}`, slug: `n-${counter}`, ownerUserId: userId, ...values })
      .returning({ id: projects.id })
    return row?.id as string
  }

  /** A session whose last activity is `lastMessageAt`, or `updatedAt` when it has no message. */
  const session = async (
    projectId: string,
    activity: { lastMessageAt?: Date; updatedAt: Date },
  ): Promise<string> => {
    counter += 1
    const id = `nightly-${counter}`
    await db.insert(sessions).values({
      id,
      source: "claude_code",
      userId,
      projectId,
      lastMessageAt: activity.lastMessageAt ?? null,
      updatedAt: activity.updatedAt,
    })
    return id
  }

  const quietSession = (projectId: string, now: Date, hours = 8): Promise<string> =>
    session(projectId, { lastMessageAt: hoursBefore(now, hours), updatedAt: hoursBefore(now, 1) })

  /** Links a github.com pull request in `state` to the session, as if the session opened it. */
  const linkPullRequest = async (sessionId: string, state: "open" | "merged" | "closed") => {
    counter += 1
    const [repo] = await db
      .insert(repos)
      .values({ host: "github.com", owner: "acme", repoName: `r${counter}`, ownerUserId: userId })
      .returning({ id: repos.id })
    const [pr] = await db
      .insert(pullRequests)
      .values({ repoId: repo?.id as string, number: counter, state })
      .returning({ id: pullRequests.id })
    await db.insert(sessionPullRequests).values({ sessionId, prId: pr?.id as string })
    return pr?.id as string
  }

  /** A session whose last message was `hours` ago, so it is not yet quiet for 6 hours. */
  const busySession = (projectId: string, now: Date, hours = 1): Promise<string> =>
    session(projectId, {
      lastMessageAt: hoursBefore(now, hours),
      updatedAt: hoursBefore(now, hours),
    })

  const reviewRows = () => db.select().from(sessionReviews)

  const reviewedIds = async (): Promise<ReadonlyArray<string>> =>
    (await reviewRows()).map((row) => row.sessionId).sort()

  const lastPick = async (projectId: string): Promise<Date | null> => {
    const [row] = await db
      .select({ at: projects.lastNightlyPickAt })
      .from(projects)
      .where(eq(projects.id, projectId))
    return row?.at ?? null
  }

  test("SC4: only projects with automatic review on are picked", async () => {
    const now = ist(11, 2)
    const on = await project({ autoReview: true })
    const off = await project()
    const onSessions = [await quietSession(on, now), await quietSession(on, now)]
    await quietSession(off, now)
    await quietSession(off, now)

    const result = await queueNightlyReviews(db, { ...DEFAULTS, now })

    expect(result).toEqual({ picked: 1, queued: 2 })
    expect(await reviewedIds()).toEqual([...onSessions].sort())
    for (const row of await reviewRows()) expect(row.status).toBe("waiting")
    expect(await lastPick(off)).toBeNull()
    expect(await lastPick(on)).toEqual(now)
  })

  test("SC5: only sessions quiet for 6 hours with no review row are picked; rows are left alone", async () => {
    const now = ist(11, 2)
    const on = await project({ autoReview: true })
    const quiet = await quietSession(on, now, 7)
    const busy = await session(on, {
      lastMessageAt: hoursBefore(now, 5),
      updatedAt: hoursBefore(now, 5),
    })
    const noMessages = await session(on, { updatedAt: hoursBefore(now, 7) })
    const doneRow = await quietSession(on, now, 9)
    const failedRow = await quietSession(on, now, 9)
    const earlier = new Date(Date.UTC(2026, 0, 1))
    await db.insert(sessionReviews).values([
      {
        sessionId: doneRow,
        projectId: on,
        analyzer: ANALYZER,
        status: "done",
        attempts: 1,
        outcome: "productive",
        summary: "kept",
        signals: {},
        updatedAt: earlier,
      },
      {
        sessionId: failedRow,
        projectId: on,
        analyzer: ANALYZER,
        status: "failed",
        attempts: 3,
        error: "harnessFailed: boom",
        updatedAt: earlier,
      },
    ])
    const before = await reviewRows()

    const result = await queueNightlyReviews(db, { ...DEFAULTS, now })

    expect(result).toEqual({ picked: 1, queued: 2 })
    const rows = await reviewRows()
    const waiting = rows.filter((row) => row.status === "waiting")
    expect(waiting.map((row) => row.sessionId).sort()).toEqual([quiet, noMessages].sort())
    for (const row of waiting) {
      expect(row).toMatchObject({ harness: null, model: null, prompt: null, attempts: 0 })
    }
    expect(rows.some((row) => row.sessionId === busy)).toBe(false)
    for (const kept of before) {
      expect(rows.find((row) => row.id === kept.id)).toEqual(kept)
    }
  })

  test("SC6: at most the limit per project, the longest quiet first", async () => {
    const now = ist(11, 2)
    const on = await project({ autoReview: true })
    const byHoursAgo = new Map<number, string>()
    for (let hours = 7; hours <= 18; hours += 1)
      byHoursAgo.set(hours, await quietSession(on, now, hours))

    const result = await queueNightlyReviews(db, { ...DEFAULTS, now })

    expect(result).toEqual({ picked: 1, queued: 10 })
    const reviewed = await reviewedIds()
    expect(reviewed).not.toContain(byHoursAgo.get(7))
    expect(reviewed).not.toContain(byHoursAgo.get(8))
    for (let hours = 9; hours <= 18; hours += 1) expect(reviewed).toContain(byHoursAgo.get(hours))
  })

  test("a session last active more than a month ago is not picked", async () => {
    const now = ist(11, 2)
    const on = await project({ autoReview: true })
    const recent = await quietSession(on, now, 29 * 24)
    await quietSession(on, now, 31 * 24)
    await session(on, { updatedAt: hoursBefore(now, 31 * 24) })

    const result = await queueNightlyReviews(db, { ...DEFAULTS, now })

    expect(result).toEqual({ picked: 1, queued: 1 })
    expect(await reviewedIds()).toEqual([recent])
  })

  test("SC7: a second pick the same day picks nothing", async () => {
    const first = ist(11, 2)
    const on = await project({ autoReview: true })
    for (let i = 0; i < 3; i += 1) await quietSession(on, first)
    await queueNightlyReviews(db, { ...DEFAULTS, now: first })

    const second = ist(11, 23, 59)
    const added = [await quietSession(on, second), await quietSession(on, second)]
    const result = await queueNightlyReviews(db, { ...DEFAULTS, now: second })

    expect(result).toEqual({ picked: 0, queued: 0 })
    const reviewed = await reviewedIds()
    expect(reviewed).toHaveLength(3)
    for (const id of added) expect(reviewed).not.toContain(id)
    expect(await lastPick(on)).toEqual(first)
  })

  test("SC8: before the day's time nothing is picked, not even for the night before", async () => {
    const twoNightsAgo = ist(9, 1)
    const on = await project({ autoReview: true, lastNightlyPickAt: twoNightsAgo })
    const now = ist(11, 0, 30)
    await quietSession(on, now)

    const result = await queueNightlyReviews(db, { ...DEFAULTS, now })

    expect(result).toEqual({ picked: 0, queued: 0 })
    expect(await reviewRows()).toHaveLength(0)
    expect(await lastPick(on)).toEqual(twoNightsAgo)
  })

  test.each([
    { label: "picked at 02:00 the night before", stamp: ist(10, 2), now: ist(11, 2) },
    { label: "caught up at 09:00 the day before", stamp: ist(10, 9), now: ist(11, 1) },
    { label: "switched on at 00:30 the same night", stamp: ist(11, 0, 30), now: ist(11, 1) },
  ])("a project $label is picked again once the day's time comes", async ({ stamp, now }) => {
    const on = await project({ autoReview: true, lastNightlyPickAt: stamp })
    const quiet = await quietSession(on, now)

    const result = await queueNightlyReviews(db, { ...DEFAULTS, now })

    expect(result).toEqual({ picked: 1, queued: 1 })
    expect(await reviewedIds()).toEqual([quiet])
    expect(await lastPick(on)).toEqual(now)
  })

  test("a project switched on at 14:00 waits for the next night", async () => {
    const switchedOn = ist(11, 14)
    const on = await project({ autoReview: true, lastNightlyPickAt: switchedOn })
    await quietSession(on, switchedOn)

    expect(await queueNightlyReviews(db, { ...DEFAULTS, now: ist(11, 23, 59) })).toEqual({
      picked: 0,
      queued: 0,
    })
    expect(await queueNightlyReviews(db, { ...DEFAULTS, now: ist(12, 1) })).toEqual({
      picked: 1,
      queued: 1,
    })
  })

  test("SC9: the time of day is read in the configured zone", async () => {
    const on = await project({ autoReview: true })
    const beforeTime = new Date(Date.UTC(2026, 10, 11, 0, 30)) // 06:00 in India
    await quietSession(on, beforeTime)
    await quietSession(on, beforeTime)
    const utc = { ...DEFAULTS, timeZone: "UTC" }

    expect(await queueNightlyReviews(db, { ...utc, now: beforeTime })).toEqual({
      picked: 0,
      queued: 0,
    })
    expect(
      await queueNightlyReviews(db, { ...utc, now: new Date(Date.UTC(2026, 10, 11, 1, 0)) }),
    ).toEqual({ picked: 1, queued: 2 })
  })
  describe("a session whose pull request is merged or closed", () => {
    test.each(["merged", "closed"] as const)(
      "SC1: a session whose pull request is %s is queued before it goes quiet",
      async (state) => {
        const now = ist(11, 2)
        const on = await project({ autoReview: true })
        const ended = await busySession(on, now)
        await linkPullRequest(ended, state)

        const result = await queueNightlyReviews(db, { ...DEFAULTS, now })

        expect(result).toEqual({ picked: 1, queued: 1 })
        const rows = await reviewRows()
        expect(rows.map((row) => row.sessionId)).toEqual([ended])
        expect(rows[0]?.status).toBe("waiting")
      },
    )

    test("SC2: a session whose pull request is still open waits for the 6-hour rule", async () => {
      const now = ist(11, 2)
      const on = await project({ autoReview: true })
      const openPr = await busySession(on, now)
      await linkPullRequest(openPr, "open")
      const quiet = await quietSession(on, now, 8)

      const result = await queueNightlyReviews(db, { ...DEFAULTS, now })

      expect(result).toEqual({ picked: 1, queued: 1 })
      expect(await reviewedIds()).toEqual([quiet])
    })

    test("SC3: a reviewed or month-old session is left alone even when its pull request ended", async () => {
      const now = ist(11, 2)
      const on = await project({ autoReview: true })
      const reviewed = await busySession(on, now)
      await linkPullRequest(reviewed, "merged")
      const old = await busySession(on, now, 31 * 24)
      await linkPullRequest(old, "merged")
      await db.insert(sessionReviews).values({
        sessionId: reviewed,
        projectId: on,
        analyzer: ANALYZER,
        status: "done",
        attempts: 1,
        outcome: "productive",
        summary: "kept",
        signals: {},
        updatedAt: new Date(Date.UTC(2026, 0, 1)),
      })
      const before = await reviewRows()

      const result = await queueNightlyReviews(db, { ...DEFAULTS, now })

      expect(result).toEqual({ picked: 1, queued: 0 })
      expect(await reviewRows()).toEqual(before)
    })

    test("SC4: the per-project limit counts merged-PR sessions, oldest activity first", async () => {
      const now = ist(11, 2)
      const on = await project({ autoReview: true })
      const quiet: string[] = []
      for (let hours = 9; hours <= 16; hours += 1) quiet.push(await quietSession(on, now, hours))
      const merged = new Map<number, string>()
      for (let hours = 1; hours <= 4; hours += 1) {
        const id = await busySession(on, now, hours)
        await linkPullRequest(id, "merged")
        merged.set(hours, id)
      }

      const result = await queueNightlyReviews(db, { ...DEFAULTS, now })

      expect(result).toEqual({ picked: 1, queued: 10 })
      const reviewed = await reviewedIds()
      for (const id of quiet) expect(reviewed).toContain(id)
      expect(reviewed).toContain(merged.get(3))
      expect(reviewed).toContain(merged.get(4))
      expect(reviewed).not.toContain(merged.get(1))
      expect(reviewed).not.toContain(merged.get(2))
    })

    test("SC5: a pull request that ends after the night's pick waits for the next night", async () => {
      const first = ist(11, 2)
      const on = await project({ autoReview: true })
      await quietSession(on, first)
      await queueNightlyReviews(db, { ...DEFAULTS, now: first })

      const second = ist(11, 23, 59)
      const late = await busySession(on, second)
      await linkPullRequest(late, "merged")
      const result = await queueNightlyReviews(db, { ...DEFAULTS, now: second })

      expect(result).toEqual({ picked: 0, queued: 0 })
      expect(await reviewedIds()).not.toContain(late)
    })

    test("SC6: a pull request a session opens is stored as open", async () => {
      const now = ist(11, 2)
      const on = await project({ autoReview: true })
      const opener = await busySession(on, now)
      const [repo] = await db
        .insert(repos)
        .values({ host: "github.com", owner: "acme", repoName: "opened", ownerUserId: userId })
        .returning({ id: repos.id })
      await insertOpened(db, [{ repoId: repo?.id as string, number: 7, sessionId: opener }])

      const [row] = await db
        .select({
          id: pullRequests.id,
          state: pullRequests.state,
          closedAt: pullRequests.closedAt,
          checkedAt: pullRequests.checkedAt,
        })
        .from(pullRequests)
        .where(eq(pullRequests.repoId, repo?.id as string))
      expect(row).toMatchObject({ state: "open", closedAt: null, checkedAt: null })
      await expect(
        db.execute(sql`update "pullRequests" set "state" = 'draft' where "id" = ${row?.id}`),
      ).rejects.toThrow(/pullRequests_state_check/)
    })
  })
})
