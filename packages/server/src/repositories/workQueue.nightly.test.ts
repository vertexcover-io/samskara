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
  describe("sessions that grew after their review", () => {
    /** A message at `at`, stored at `storedAt` (by default the same instant). */
    const message = async (sessionId: string, at: Date | null, storedAt?: Date) => {
      counter += 1
      const [row] = await db
        .insert(messages)
        .values({
          sessionId,
          lineUuid: crypto.randomUUID(),
          subIndex: 0,
          msgType: "message",
          role: "user",
          lineNumber: counter,
          raw: {},
          sourceSchemaVersion: 1,
          content: { type: "text", value: "hi" },
          timestamp: at,
          createdAt: storedAt ?? at ?? new Date(0),
        })
        .returning({ id: messages.id })
      return row?.id as string
    }

    const run = async (
      sessionId: string,
      projectId: string,
      values: { status: "done" | "failed" | "waiting"; at: Date; lastMessageId?: string },
    ) => {
      const result =
        values.status === "done" ? { outcome: "productive", summary: "s", signals: {} } : {}
      const [row] = await db
        .insert(sessionReviews)
        .values({
          sessionId,
          projectId,
          analyzer: ANALYZER,
          status: values.status,
          lastMessageId: values.lastMessageId ?? null,
          createdAt: values.at,
          updatedAt: values.at,
          ...result,
        })
        .returning({ id: sessionReviews.id })
      return row?.id as string
    }

    const waitingFor = async (sessionId: string) =>
      (await reviewRows()).filter((row) => row.sessionId === sessionId && row.status === "waiting")

    /** A quiet session reviewed by a done run that read up to `hours + 2` hours ago. */
    const reviewedQuiet = async (projectId: string, now: Date, grew: boolean, hours = 8) => {
      const id = await quietSession(projectId, now, hours)
      const read = await message(id, hoursBefore(now, hours + 2))
      const done = await run(id, projectId, {
        status: "done",
        at: hoursBefore(now, hours + 1),
        lastMessageId: read,
      })
      if (grew) await message(id, hoursBefore(now, hours))
      return { id, done }
    }

    test("SC29: a reviewed quiet session with a message after its review gets a new-part run based on that review", async () => {
      const now = ist(11, 2)
      const on = await project({ autoReview: true })
      const { id, done } = await reviewedQuiet(on, now, true)

      const result = await queueNightlyReviews(db, { ...DEFAULTS, now })

      expect(result).toEqual({ picked: 1, queued: 1 })
      expect(await waitingFor(id)).toEqual([
        expect.objectContaining({ newPartOnly: true, basedOn: done }),
      ])
    })

    test("SC30: a reviewed quiet session with nothing after its review is skipped", async () => {
      const now = ist(11, 2)
      const on = await project({ autoReview: true })
      const { id } = await reviewedQuiet(on, now, false)

      const result = await queueNightlyReviews(db, { ...DEFAULTS, now })

      expect(result).toEqual({ picked: 1, queued: 0 })
      expect(await waitingFor(id)).toEqual([])
    })

    test.each([
      { name: "with an earlier done run, as a new-part run on it", earlierDone: true },
      { name: "with no done run, as a full run", earlierDone: false },
    ])(
      "SC31: a failed review comes back only once a message is stored after it failed: $name",
      async ({ earlierDone }) => {
        const night1 = ist(11, 2)
        const night2 = ist(12, 2)
        const on = await project({ autoReview: true })
        const id = await quietSession(on, night1, 8)
        const read = await message(id, hoursBefore(night1, 12))
        const done = earlierDone
          ? await run(id, on, { status: "done", at: hoursBefore(night1, 11), lastMessageId: read })
          : null
        await run(id, on, { status: "failed", at: hoursBefore(night1, 10) })
        // A message the failed run already had in front of it: no reason to try again.
        await message(id, hoursBefore(night1, 9.5), hoursBefore(night1, 10.5))

        await queueNightlyReviews(db, { ...DEFAULTS, now: night1 })
        expect(await waitingFor(id)).toEqual([])

        await message(id, hoursBefore(night2, 12))
        await queueNightlyReviews(db, { ...DEFAULTS, now: night2 })
        expect(await waitingFor(id)).toEqual([
          expect.objectContaining({ newPartOnly: earlierDone, basedOn: done }),
        ])
      },
    )

    test("SC32: for a reviewed session only a pull request that ended after its last review counts", async () => {
      const now = ist(11, 2)
      const on = await project({ autoReview: true })
      const grownBusy = async () => {
        const id = await busySession(on, now)
        const read = await message(id, hoursBefore(now, 5))
        await run(id, on, { status: "done", at: hoursBefore(now, 3), lastMessageId: read })
        await message(id, hoursBefore(now, 1))
        return id
      }
      const endedBefore = await grownBusy()
      await linkPullRequest(endedBefore, "closed", "github.com", hoursBefore(now, 4))
      const endedAfter = await grownBusy()
      await linkPullRequest(endedAfter, "closed", "github.com", hoursBefore(now, 2))

      await queueNightlyReviews(db, { ...DEFAULTS, now })

      expect(await waitingFor(endedBefore)).toEqual([])
      expect(await waitingFor(endedAfter)).toHaveLength(1)
    })

    test("SC33: never reviewed goes first, then an ended pull request, and the oldest reviewed one waits", async () => {
      const now = ist(11, 2)
      const on = await project({ autoReview: true })
      const { id: oldestReviewed } = await reviewedQuiet(on, now, true, 20)
      const prSession = await busySession(on, now)
      const read = await message(prSession, hoursBefore(now, 5))
      await run(prSession, on, { status: "done", at: hoursBefore(now, 3), lastMessageId: read })
      await message(prSession, hoursBefore(now, 1))
      await linkPullRequest(prSession, "merged", "github.com", hoursBefore(now, 2))
      const neverReviewed = await quietSession(on, now, 8)

      await queueNightlyReviews(db, { ...DEFAULTS, limit: 2, now })

      expect(await waitingFor(neverReviewed)).toHaveLength(1)
      expect(await waitingFor(prSession)).toHaveLength(1)
      expect(await waitingFor(oldestReviewed)).toEqual([])
    })

    test("SC34: a session with a run waiting is never picked again, even with new messages", async () => {
      const now = ist(11, 2)
      const on = await project({ autoReview: true })
      const { id } = await reviewedQuiet(on, now, true)
      await run(id, on, { status: "waiting", at: hoursBefore(now, 7) })

      const result = await queueNightlyReviews(db, { ...DEFAULTS, now })

      expect(result).toEqual({ picked: 1, queued: 0 })
      expect(await waitingFor(id)).toHaveLength(1)
    })

    test("SC36: GitHub is asked only about the open pull request of a reviewed session that gained messages", async () => {
      const now = ist(11, 2)
      const on = await project({ autoReview: true })
      const reviewedBusy = async (grew: boolean) => {
        const id = await busySession(on, now)
        const read = await message(id, hoursBefore(now, 5))
        await run(id, on, { status: "done", at: hoursBefore(now, 3), lastMessageId: read })
        if (grew) await message(id, hoursBefore(now, 1))
        return linkPullRequest(id, "open")
      }
      await reviewedBusy(false)
      const wanted = await reviewedBusy(true)

      const listed = await pullRequestsToCheck(db, { ...DEFAULTS, now })

      expect(listed.map((pr) => pr.id)).toEqual([wanted])
    })
  })
})
