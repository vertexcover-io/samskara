import { randomUUID } from "node:crypto"
import { eq, sql } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest"
import type { Db } from "../db/client.js"
import {
  messages,
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
import { PR_CHECK_LIMIT, pullRequestsToCheck, queueNightlyReviews } from "./workQueue.repo.js"

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

  /** Links a pull request in `state` to the session, as if the session opened it. */
  const linkPullRequest = async (
    sessionId: string,
    state: "open" | "merged" | "closed",
    host = "github.com",
    closedAt: Date | null = null,
  ) => {
    counter += 1
    const [repo] = await db
      .insert(repos)
      .values({ host, owner: "acme", repoName: `r${counter}`, ownerUserId: userId })
      .returning({ id: repos.id })
    const [pr] = await db
      .insert(pullRequests)
      .values({ repoId: repo?.id as string, number: counter, state, closedAt })
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

    test("SC4: merged-PR sessions go first within the per-project limit, then the oldest quiet ones", async () => {
      const now = ist(11, 2)
      const on = await project({ autoReview: true })
      const quiet = new Map<number, string>()
      for (let hours = 9; hours <= 16; hours += 1)
        quiet.set(hours, await quietSession(on, now, hours))
      const merged: string[] = []
      for (let hours = 1; hours <= 4; hours += 1) {
        const id = await busySession(on, now, hours)
        await linkPullRequest(id, "merged")
        merged.push(id)
      }

      const result = await queueNightlyReviews(db, { ...DEFAULTS, now })

      expect(result).toEqual({ picked: 1, queued: 10 })
      const reviewed = await reviewedIds()
      for (const id of merged) expect(reviewed).toContain(id)
      for (let hours = 11; hours <= 16; hours += 1) expect(reviewed).toContain(quiet.get(hours))
      expect(reviewed).not.toContain(quiet.get(9))
      expect(reviewed).not.toContain(quiet.get(10))
    })

    test("a merged-PR session is picked even when a busy project has more quiet sessions than the limit", async () => {
      const now = ist(11, 2)
      const on = await project({ autoReview: true })
      for (let hours = 7; hours <= 30; hours += 1) await quietSession(on, now, hours)
      const merged = await busySession(on, now, 1)
      await linkPullRequest(merged, "merged")

      await queueNightlyReviews(db, { ...DEFAULTS, now })

      expect(await reviewedIds()).toContain(merged)
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
  describe("the pull requests the nightly check asks GitHub about", () => {
    test("SC12: only open github.com pull requests of tonight's not-yet-quiet candidate sessions are listed", async () => {
      const now = ist(11, 2)
      const a = await project({ autoReview: true })
      const candidate = await busySession(a, now)
      const wanted = await linkPullRequest(candidate, "open")
      await linkPullRequest(await busySession(a, now), "merged")
      await linkPullRequest(await busySession(a, now), "open", "gitlab.com")
      const reviewed = await busySession(a, now)
      await linkPullRequest(reviewed, "open")
      await db.insert(sessionReviews).values({
        sessionId: reviewed,
        projectId: a,
        analyzer: ANALYZER,
        status: "waiting",
      })
      await linkPullRequest(await busySession(a, now, 31 * 24), "open")
      // Quiet for 6 hours already, so the pick takes it whatever GitHub says.
      await linkPullRequest(await quietSession(a, now), "open")
      const b = await project()
      await linkPullRequest(await busySession(b, now), "open")
      const c = await project({ autoReview: true, lastNightlyPickAt: ist(11, 1, 30) })
      await linkPullRequest(await busySession(c, now), "open")

      const listed = await pullRequestsToCheck(db, { ...DEFAULTS, now })

      expect(listed).toHaveLength(1)
      const [repo] = await db
        .select({ owner: repos.owner, repoName: repos.repoName, number: pullRequests.number })
        .from(pullRequests)
        .innerJoin(repos, eq(repos.id, pullRequests.repoId))
        .where(eq(pullRequests.id, wanted))
      expect(listed[0]).toEqual({
        id: wanted,
        owner: repo?.owner,
        repo: repo?.repoName,
        number: repo?.number,
      })
    })

    test("SC13: at most 200 are listed, never-checked first", async () => {
      const now = ist(11, 2)
      const on = await project({ autoReview: true })
      const opener = await busySession(on, now)
      const [repo] = await db
        .insert(repos)
        .values({ host: "GitHub.com", owner: "acme", repoName: "busy", ownerUserId: userId })
        .returning({ id: repos.id })
      const neverChecked = Array.from({ length: 201 }, (_, i) => ({
        repoId: repo?.id as string,
        number: i + 1,
      }))
      const checked = [
        { repoId: repo?.id as string, number: 900, checkedAt: hoursBefore(now, 24) },
        { repoId: repo?.id as string, number: 901, checkedAt: hoursBefore(now, 7 * 24) },
      ]
      const inserted = await db
        .insert(pullRequests)
        .values([...neverChecked, ...checked])
        .returning({ id: pullRequests.id, checkedAt: pullRequests.checkedAt })
      await db
        .insert(sessionPullRequests)
        .values(inserted.map((pr) => ({ sessionId: opener, prId: pr.id })))
      const checkedIds = inserted.filter((pr) => pr.checkedAt !== null).map((pr) => pr.id)

      const listed = await pullRequestsToCheck(db, { ...DEFAULTS, now })

      expect(PR_CHECK_LIMIT).toBe(200)
      expect(listed).toHaveLength(200)
      for (const id of checkedIds) expect(listed.map((pr) => pr.id)).not.toContain(id)
    })
  })

  describe("a reviewed session with new messages", () => {
    /** Stores a message on `lineNumber` of `trackId`, stored at `createdAt` when given. */
    const message = (
      sessionId: string,
      lineNumber: number,
      values: { trackId?: string; createdAt?: Date } = {},
    ) =>
      db.insert(messages).values({
        sessionId,
        lineUuid: randomUUID(),
        subIndex: 0,
        lineNumber,
        trackId: values.trackId ?? "main",
        msgType: "message",
        role: "user",
        source: "claude_code",
        sourceRelativePath: "test.jsonl",
        raw: {},
        sourceSchemaVersion: 1,
        content: `line ${lineNumber}`,
        ...(values.createdAt ? { createdAt: values.createdAt } : {}),
      })

    const mainLines = async (sessionId: string, from: number, to: number) => {
      for (let line = from; line <= to; line += 1) await message(sessionId, line)
    }

    const doneReview = (sessionId: string, projectId: string, reviewedThrough: number) =>
      db
        .insert(sessionReviews)
        .values({
          sessionId,
          projectId,
          analyzer: ANALYZER,
          status: "done",
          attempts: 1,
          outcome: "productive",
          summary: "kept",
          signals: {},
          harness: "claude",
          reviewedThrough,
          updatedAt: new Date(Date.UTC(2026, 0, 1)),
        })
        .returning()
        .then((rows) => rows[0] as typeof sessionReviews.$inferSelect)

    const rowOf = async (sessionId: string) =>
      (await reviewRows()).find((row) => row.sessionId === sessionId)

    test("SC1: a session with a main-track message after its review is queued again, keeping its result", async () => {
      const now = ist(11, 2)
      const on = await project({ autoReview: true })
      const reviewed = await quietSession(on, now)
      await mainLines(reviewed, 1, 5)
      const before = await doneReview(reviewed, on, 3)

      const result = await queueNightlyReviews(db, { ...DEFAULTS, now })

      expect(result).toEqual({ picked: 1, queued: 1 })
      expect(await rowOf(reviewed)).toMatchObject({
        id: before.id,
        status: "waiting",
        attempts: 0,
        error: null,
        outcome: "productive",
        summary: "kept",
        newPartOnly: true,
        harness: null,
        model: null,
        prompt: null,
      })
    })

    test("SC2: a session with nothing after its review on the main track is left alone", async () => {
      const now = ist(11, 2)
      const on = await project({ autoReview: true })
      const reviewed = await quietSession(on, now)
      await mainLines(reviewed, 1, 5)
      await message(reviewed, 9, { trackId: "agent-a1" })
      await doneReview(reviewed, on, 5)
      const before = await reviewRows()

      const result = await queueNightlyReviews(db, { ...DEFAULTS, now })

      expect(result).toEqual({ picked: 1, queued: 0 })
      expect(await reviewRows()).toEqual(before)
    })

    test("SC3: a re-review waits for the quiet rule unless its pull request ended after the review", async () => {
      // doneReview stamps the review on 2026-01-01.
      const now = ist(11, 2)
      const on = await project({ autoReview: true })
      const busy = await busySession(on, now)
      const mergedBefore = await busySession(on, now)
      await linkPullRequest(mergedBefore, "merged", "github.com", new Date(Date.UTC(2025, 11, 31)))
      const mergedAfter = await busySession(on, now)
      await linkPullRequest(mergedAfter, "merged", "github.com", new Date(Date.UTC(2026, 0, 2)))
      for (const id of [busy, mergedBefore, mergedAfter]) {
        await mainLines(id, 1, 5)
        await doneReview(id, on, 3)
      }

      const result = await queueNightlyReviews(db, { ...DEFAULTS, now })

      expect(result).toEqual({ picked: 1, queued: 1 })
      expect((await rowOf(mergedAfter))?.status).toBe("waiting")
      expect((await rowOf(mergedBefore))?.status).toBe("done")
      expect((await rowOf(busy))?.status).toBe("done")
    })

    test("SC4: a failed review comes back only once a main-track message is stored after it failed", async () => {
      const now = ist(11, 2)
      const on = await project({ autoReview: true })
      const failedAt = hoursBefore(now, 10)
      const nothingNew = await quietSession(on, now)
      const somethingNew = await quietSession(on, now)
      await message(nothingNew, 1, { createdAt: hoursBefore(now, 12) })
      await message(somethingNew, 1, { createdAt: hoursBefore(now, 12) })
      await message(somethingNew, 2, { createdAt: hoursBefore(now, 9) })
      for (const sessionId of [nothingNew, somethingNew]) {
        await db.insert(sessionReviews).values({
          sessionId,
          projectId: on,
          analyzer: ANALYZER,
          status: "failed",
          attempts: 3,
          error: "harnessFailed: boom",
          updatedAt: failedAt,
        })
      }

      const result = await queueNightlyReviews(db, { ...DEFAULTS, now })

      expect(result).toEqual({ picked: 1, queued: 1 })
      expect(await rowOf(somethingNew)).toMatchObject({
        status: "waiting",
        attempts: 0,
        error: null,
        newPartOnly: true,
      })
      expect(await rowOf(nothingNew)).toMatchObject({
        status: "failed",
        attempts: 3,
        error: "harnessFailed: boom",
      })
    })

    test("a busy session whose first review failed after its pull request merged is picked through that pull request once a message is stored after the failure", async () => {
      const now = ist(11, 2)
      const on = await project({ autoReview: true })
      const failedFirst = await busySession(on, now)
      await linkPullRequest(failedFirst, "merged", "github.com", hoursBefore(now, 5))
      await message(failedFirst, 1, { createdAt: hoursBefore(now, 6) })
      await message(failedFirst, 2, { createdAt: hoursBefore(now, 2) })
      await db.insert(sessionReviews).values({
        sessionId: failedFirst,
        projectId: on,
        analyzer: ANALYZER,
        status: "failed",
        attempts: 3,
        error: "harnessFailed: boom",
        updatedAt: hoursBefore(now, 3),
      })

      const result = await queueNightlyReviews(db, { ...DEFAULTS, now })

      expect(result).toEqual({ picked: 1, queued: 1 })
      expect(await rowOf(failedFirst)).toMatchObject({ status: "waiting", attempts: 0 })
    })

    test("SC5: a never-reviewed session takes the limit before a re-review active longer ago", async () => {
      const now = ist(11, 2)
      const on = await project({ autoReview: true })
      const reviewed = await quietSession(on, now, 30)
      await mainLines(reviewed, 1, 5)
      await doneReview(reviewed, on, 3)
      const fresh = await quietSession(on, now, 8)

      const result = await queueNightlyReviews(db, { ...DEFAULTS, now, limit: 1 })

      expect(result).toEqual({ picked: 1, queued: 1 })
      expect(await rowOf(fresh)).toMatchObject({ status: "waiting", newPartOnly: false })
      expect((await rowOf(reviewed))?.status).toBe("done")
    })

    test("a session whose first review failed takes the limit before a re-review active longer ago", async () => {
      const now = ist(11, 2)
      const on = await project({ autoReview: true })
      const reviewed = await quietSession(on, now, 40)
      await mainLines(reviewed, 1, 5)
      await doneReview(reviewed, on, 3)
      const failedFirst = await quietSession(on, now, 30)
      await message(failedFirst, 1, { createdAt: hoursBefore(now, 31) })
      await db.insert(sessionReviews).values({
        sessionId: failedFirst,
        projectId: on,
        analyzer: ANALYZER,
        status: "failed",
        attempts: 3,
        error: "harnessFailed: boom",
        updatedAt: hoursBefore(now, 35),
      })

      const result = await queueNightlyReviews(db, { ...DEFAULTS, now, limit: 1 })

      expect(result).toEqual({ picked: 1, queued: 1 })
      expect((await rowOf(failedFirst))?.status).toBe("waiting")
      expect((await rowOf(reviewed))?.status).toBe("done")
    })

    test("a re-review of a session moved to another project moves its review row there too", async () => {
      const now = ist(11, 2)
      const before = await project()
      const on = await project({ autoReview: true })
      const moved = await quietSession(on, now)
      await mainLines(moved, 1, 5)
      await doneReview(moved, before, 3)

      await queueNightlyReviews(db, { ...DEFAULTS, now })

      expect(await rowOf(moved)).toMatchObject({ status: "waiting", projectId: on })
    })

    test("SC6: a waiting or running review is never taken again", async () => {
      const now = ist(11, 2)
      const on = await project({ autoReview: true })
      for (const status of ["waiting", "running"] as const) {
        const id = await quietSession(on, now)
        await mainLines(id, 1, 5)
        await db.insert(sessionReviews).values({
          sessionId: id,
          projectId: on,
          analyzer: ANALYZER,
          status,
          attempts: 1,
          reviewedThrough: 3,
        })
      }
      const before = await reviewRows()

      const result = await queueNightlyReviews(db, { ...DEFAULTS, now })

      expect(result).toEqual({ picked: 1, queued: 0 })
      expect(await reviewRows()).toEqual(before)
    })

    test("SC7: the PR check lists a busy reviewed session's open pull request only when it has something new", async () => {
      const now = ist(11, 2)
      const on = await project({ autoReview: true })
      const withNew = await busySession(on, now)
      const withoutNew = await busySession(on, now)
      const wanted = await linkPullRequest(withNew, "open")
      await linkPullRequest(withoutNew, "open")
      await mainLines(withNew, 1, 5)
      await mainLines(withoutNew, 1, 3)
      await doneReview(withNew, on, 3)
      await doneReview(withoutNew, on, 3)

      const listed = await pullRequestsToCheck(db, { ...DEFAULTS, now })

      expect(listed.map((pr) => pr.id)).toEqual([wanted])
    })
  })
})
