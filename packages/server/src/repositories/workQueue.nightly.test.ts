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
import { DEFAULT_MIN_NEW_USER_MESSAGES } from "../lib/env.js"
import { insertOpened } from "./pullRequests.repo.js"
import {
  BRANCH_CHECK_LIMIT,
  branchesToLookUp,
  PR_CHECK_LIMIT,
  pullRequestsToCheck,
  queueNightlyReviews,
} from "./workQueue.repo.js"

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

  /**
   * A message at `at`, stored at `storedAt` (by default the same instant). `extra` sets any other
   * column, such as `subType`, `details` or `content`.
   */
  const message = async (
    sessionId: string,
    at: Date | null,
    storedAt?: Date,
    msgType:
      | "message"
      | "usage"
      | "turnEvent"
      | "custom"
      | "toolResult"
      | "localCommand" = "message",
    who: { role?: "user" | "assistant"; trackId?: string } = {},
    extra: Partial<typeof messages.$inferInsert> = {},
  ) => {
    counter += 1
    const [row] = await db
      .insert(messages)
      .values({
        sessionId,
        lineUuid: crypto.randomUUID(),
        subIndex: 0,
        msgType,
        role: msgType === "message" ? (who.role ?? "user") : (who.role ?? null),
        trackId: who.trackId ?? "main",
        lineNumber: counter,
        raw: {},
        sourceSchemaVersion: 1,
        content: { type: "text", value: "hi" },
        timestamp: at,
        createdAt: storedAt ?? at ?? new Date(0),
        ...extra,
      })
      .returning({ id: messages.id })
    return row?.id as string
  }

  /** Long before every review the tests write, so these messages are never new after a run. */
  const TYPED_AT = new Date(Date.UTC(2026, 0, 1))

  /**
   * A session whose last activity is `lastMessageAt`, or `updatedAt` when it has no message, with
   * `typed` messages the person typed (by default enough to be picked).
   */
  const session = async (
    projectId: string,
    activity: { lastMessageAt?: Date; updatedAt: Date; typed?: number },
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
    for (let i = 0; i < (activity.typed ?? DEFAULT_MIN_NEW_USER_MESSAGES); i += 1)
      await message(id, TYPED_AT)
    return id
  }

  /** A message the person typed in the session holding `value`, as block `subIndex` of its line. */
  const yokCommand = (sessionId: string, value: string, subIndex = 0) =>
    message(
      sessionId,
      TYPED_AT,
      undefined,
      "message",
      {},
      {
        content: { type: "text", value },
        subIndex,
      },
    )

  /** A tool's output, stored as the collector stores it: no content, the text in `details`. */
  const toolResult = (sessionId: string, output: string) =>
    message(
      sessionId,
      TYPED_AT,
      undefined,
      "toolResult",
      { role: "user" },
      { content: null, details: { output } },
    )

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

  test("SC5: only sessions quiet for 6 hours, with enough typed messages and no review row, are picked; rows are left alone", async () => {
    const now = ist(11, 2)
    const on = await project({ autoReview: true })
    const quiet = await quietSession(on, now, 7)
    const busy = await session(on, {
      lastMessageAt: hoursBefore(now, 5),
      updatedAt: hoursBefore(now, 5),
    })
    const noMessages = await session(on, { updatedAt: hoursBefore(now, 7), typed: 0 })
    // Its done run read nothing, so every message would count as new after it.
    const doneRow = await session(on, {
      lastMessageAt: hoursBefore(now, 9),
      updatedAt: hoursBefore(now, 1),
      typed: 0,
    })
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

    expect(result).toEqual({ picked: 1, queued: 1 })
    const rows = await reviewRows()
    const waiting = rows.filter((row) => row.status === "waiting")
    expect(waiting.map((row) => row.sessionId)).toEqual([quiet])
    expect(rows.some((row) => row.sessionId === noMessages)).toBe(false)
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

  test("a session last active more than two weeks ago is not picked", async () => {
    const now = ist(11, 2)
    const on = await project({ autoReview: true })
    const recent = await quietSession(on, now, 13 * 24)
    await quietSession(on, now, 15 * 24)
    await session(on, { updatedAt: hoursBefore(now, 31 * 24) })

    const result = await queueNightlyReviews(db, { ...DEFAULTS, now })

    expect(result).toEqual({ picked: 1, queued: 1 })
    expect(await reviewedIds()).toEqual([recent])
  })

  test("the quiet time and the look-back window follow the settings", async () => {
    const now = ist(11, 2)
    const on = await project({ autoReview: true })
    const quietThreeHours = await quietSession(on, now, 3)
    await busySession(on, now, 1)
    const twentyDaysAgo = await quietSession(on, now, 20 * 24)
    await quietSession(on, now, 40 * 24)

    const result = await queueNightlyReviews(db, {
      ...DEFAULTS,
      now,
      quietHours: 2,
      pickWithinDays: 30,
    })

    expect(result).toEqual({ picked: 1, queued: 2 })
    expect(await reviewedIds()).toEqual([quietThreeHours, twentyDaysAgo].sort())
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
  describe("the messages a session needs the person to have typed", () => {
    /** A quiet, never-reviewed session the person typed `typed` messages in. */
    const quietTyped = (projectId: string, now: Date, typed: number): Promise<string> =>
      session(projectId, {
        lastMessageAt: hoursBefore(now, 8),
        updatedAt: hoursBefore(now, 1),
        typed,
      })

    test("SC1: a never-reviewed session needs four typed messages to be picked", async () => {
      const now = ist(11, 2)
      const on = await project({ autoReview: true })
      const three = await quietTyped(on, now, 3)
      const four = await quietTyped(on, now, 4)

      const result = await queueNightlyReviews(db, { ...DEFAULTS, now })

      expect(result).toEqual({ picked: 1, queued: 1 })
      const rows = await reviewRows()
      expect(rows).toEqual([
        expect.objectContaining({
          sessionId: four,
          status: "waiting",
          newPartOnly: false,
          basedOn: null,
        }),
      ])
      expect(rows.some((row) => row.sessionId === three)).toBe(false)
    })

    test("SC2: only messages the person typed count toward the minimum", async () => {
      const now = ist(11, 2)
      const on = await project({ autoReview: true })
      const id = await quietTyped(on, now, 3)
      await message(id, TYPED_AT, undefined, "message", { role: "assistant" })
      await message(id, TYPED_AT, undefined, "message", { role: "assistant" })
      await message(id, TYPED_AT, undefined, "message", { trackId: "agent-1" })
      await message(id, TYPED_AT, undefined, "message", {}, { subType: "toolInjection" })
      await message(id, TYPED_AT, undefined, "message", {}, { details: { isMeta: true } })
      await message(
        id,
        TYPED_AT,
        undefined,
        "toolResult",
        { role: "user" },
        { content: null, details: { output: "done" } },
      )

      const result = await queueNightlyReviews(db, { ...DEFAULTS, now })

      expect(result).toEqual({ picked: 1, queued: 0 })
      expect(await reviewRows()).toEqual([])
    })

    test("SC4: the default is 4 and follows the setting", async () => {
      const now = ist(11, 2)
      const on = await project({ autoReview: true })
      const id = await quietTyped(on, now, 1)

      await queueNightlyReviews(db, { ...DEFAULTS, now, minNewUserMessages: 1 })

      expect(DEFAULT_MIN_NEW_USER_MESSAGES).toBe(4)
      expect((await reviewRows()).map((row) => row.sessionId)).toEqual([id])
    })
  })
  describe("a session whose pull request is merged", () => {
    test("SC1: a session whose pull request is merged is queued before it goes quiet", async () => {
      const now = ist(11, 2)
      const on = await project({ autoReview: true })
      const ended = await busySession(on, now)
      await linkPullRequest(ended, "merged")

      const result = await queueNightlyReviews(db, { ...DEFAULTS, now })

      expect(result).toEqual({ picked: 1, queued: 1 })
      const rows = await reviewRows()
      expect(rows.map((row) => row.sessionId)).toEqual([ended])
      expect(rows[0]?.status).toBe("waiting")
    })

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

    test("SC3: a reviewed or two-week-old session is left alone even when its pull request ended", async () => {
      const now = ist(11, 2)
      const on = await project({ autoReview: true })
      // Its done run read nothing, so every message would count as new after it.
      const reviewed = await session(on, {
        lastMessageAt: hoursBefore(now, 1),
        updatedAt: hoursBefore(now, 1),
        typed: 0,
      })
      await linkPullRequest(reviewed, "merged")
      const old = await busySession(on, now, 15 * 24)
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
  describe("merged yok runs, then merged sessions, then quiet ones", () => {
    const TYPED_COMMAND =
      "<command-message>yok:orchestrate</command-message>\n<command-name>/yok:orchestrate</command-name>"
    const SKILL_BODY =
      "Base directory for this skill: /u/.claude/plugins/cache/yok/yok/0.0.8/skills/orchestrate\n\n# orchestrate"

    /** A never-reviewed session last active `hours` ago whose pull request is merged. */
    const merged = async (projectId: string, now: Date, hours: number): Promise<string> => {
      const id = await busySession(projectId, now, hours)
      await linkPullRequest(id, "merged")
      return id
    }

    /** `merged`, and a yok run: the person typed the orchestrate command. */
    const mergedYokRun = async (projectId: string, now: Date, hours: number) => {
      const id = await merged(projectId, now, hours)
      await yokCommand(id, TYPED_COMMAND)
      return id
    }

    test("SC5: merged yok runs go first, then merged sessions, then quiet ones", async () => {
      const now = ist(11, 2)
      const on = await project({ autoReview: true })
      const quiet20 = await quietSession(on, now, 20)
      const mergedPlain = await merged(on, now, 2)
      const yokRun = await mergedYokRun(on, now, 1)
      const quiet30 = await quietSession(on, now, 30)

      const result = await queueNightlyReviews(db, { ...DEFAULTS, limit: 3, now })

      expect(result).toEqual({ picked: 1, queued: 3 })
      expect(await reviewedIds()).toEqual([yokRun, mergedPlain, quiet30].sort())
      expect(await reviewedIds()).not.toContain(quiet20)
    })

    test("SC6: when merged sessions fill the limit no quiet session is taken", async () => {
      const now = ist(11, 2)
      const on = await project({ autoReview: true })
      const yokRun = await mergedYokRun(on, now, 1)
      const mergedPlain = await merged(on, now, 2)
      for (const hours of [30, 40, 50]) await quietSession(on, now, hours)

      await queueNightlyReviews(db, { ...DEFAULTS, limit: 2, now })

      expect(await reviewedIds()).toEqual([yokRun, mergedPlain].sort())
    })

    test("SC7: inside a group the oldest activity goes first", async () => {
      const now = ist(11, 2)
      const on = await project({ autoReview: true })
      const oneHour = await merged(on, now, 1)
      const threeHours = await merged(on, now, 3)
      const fiveHours = await merged(on, now, 5)

      await queueNightlyReviews(db, { ...DEFAULTS, limit: 2, now })

      expect(await reviewedIds()).toEqual([threeHours, fiveHours].sort())
      expect(await reviewedIds()).not.toContain(oneHour)
    })

    test("SC8: a pull request closed without merging waits out the quiet hours", async () => {
      const now = ist(11, 2)
      const on = await project({ autoReview: true })
      const busy = await busySession(on, now, 1)
      await linkPullRequest(busy, "closed")
      const quiet = await quietSession(on, now, 8)
      await linkPullRequest(quiet, "closed")

      await queueNightlyReviews(db, { ...DEFAULTS, now })

      expect(await reviewedIds()).toEqual([quiet])
    })

    test.each([
      { shape: "(a) the typed slash command", add: (id: string) => yokCommand(id, TYPED_COMMAND) },
      {
        shape: "(b) the skill body as the first block",
        add: (id: string) => yokCommand(id, SKILL_BODY),
      },
      {
        shape: "(c) a localCommand row",
        add: (id: string) =>
          message(
            id,
            TYPED_AT,
            undefined,
            "localCommand",
            {},
            {
              content: null,
              details: { command: "/yok:orchestrate", commandType: "slash", status: "unknown" },
            },
          ),
      },
      {
        shape: "(d) the skill body stamped as a tool injection",
        add: (id: string) =>
          message(
            id,
            TYPED_AT,
            undefined,
            "message",
            {},
            {
              content: { type: "text", value: SKILL_BODY },
              subType: "toolInjection",
              details: { isMeta: true },
            },
          ),
      },
    ])("SC10: $shape makes a yok run", async ({ add }) => {
      const now = ist(11, 2)
      const on = await project({ autoReview: true })
      const plain = await merged(on, now, 3)
      const yokRun = await merged(on, now, 1)
      await add(yokRun)

      await queueNightlyReviews(db, { ...DEFAULTS, limit: 1, now })

      expect(await reviewedIds()).toEqual([yokRun])
      expect(await reviewedIds()).not.toContain(plain)
    })

    test.each([
      {
        shape: "(a) a tool result quoting the command",
        add: (id: string) =>
          toolResult(id, `ran /yok:orchestrate\n<command-name>/yok:orchestrate</command-name>`),
      },
      {
        shape: "(b) a skill body that is not the line's first block",
        add: (id: string) => yokCommand(id, SKILL_BODY, 1),
      },
      {
        shape: "(c) an assistant message holding the command",
        add: (id: string) =>
          message(
            id,
            TYPED_AT,
            undefined,
            "message",
            { role: "assistant" },
            {
              content: { type: "text", value: TYPED_COMMAND },
            },
          ),
      },
      {
        shape: "(d) a subagent's user message holding the command",
        add: (id: string) =>
          message(
            id,
            TYPED_AT,
            undefined,
            "message",
            { trackId: "agent-1" },
            {
              content: { type: "text", value: TYPED_COMMAND },
            },
          ),
      },
    ])("SC11: $shape does not make a yok run", async ({ add }) => {
      const now = ist(11, 2)
      const on = await project({ autoReview: true })
      const older = await merged(on, now, 3)
      const younger = await merged(on, now, 1)
      await add(younger)

      await queueNightlyReviews(db, { ...DEFAULTS, limit: 1, now })

      expect(await reviewedIds()).toEqual([older])
    })
  })
  describe("the pull requests the nightly check asks GitHub about", () => {
    test("SC12: only open github.com pull requests of tonight's candidate sessions are listed", async () => {
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
      await linkPullRequest(await busySession(a, now, 15 * 24), "open")
      // Quiet already, but a merge would still rank it above the other quiet sessions.
      const quietWanted = await linkPullRequest(await quietSession(a, now), "open")
      const b = await project()
      await linkPullRequest(await busySession(b, now), "open")
      const c = await project({ autoReview: true, lastNightlyPickAt: ist(11, 1, 30) })
      await linkPullRequest(await busySession(c, now), "open")

      const listed = await pullRequestsToCheck(db, { ...DEFAULTS, now })

      expect(listed.map((pr) => pr.id).sort()).toEqual([wanted, quietWanted].sort())
      const [repo] = await db
        .select({ owner: repos.owner, repoName: repos.repoName, number: pullRequests.number })
        .from(pullRequests)
        .innerJoin(repos, eq(repos.id, pullRequests.repoId))
        .where(eq(pullRequests.id, wanted))
      expect(listed.find((pr) => pr.id === wanted)).toEqual({
        id: wanted,
        owner: repo?.owner,
        repo: repo?.repoName,
        number: repo?.number,
      })
    })

    test("SC21: the state check covers quiet candidates, but not a pull request already checked tonight", async () => {
      const now = ist(11, 2)
      const a = await project({ autoReview: true })
      const quiet = await linkPullRequest(await quietSession(a, now, 30), "open")
      const justFound = await linkPullRequest(await quietSession(a, now, 30), "open")
      await db.update(pullRequests).set({ checkedAt: now }).where(eq(pullRequests.id, justFound))

      const listed = await pullRequestsToCheck(db, { ...DEFAULTS, now })

      expect(listed.map((pr) => pr.id)).toEqual([quiet])
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
  describe("the branches the nightly check asks GitHub about", () => {
    const repo = async (host = "github.com") => {
      counter += 1
      const [row] = await db
        .insert(repos)
        .values({ host, owner: "acme", repoName: `branchy-${counter}`, ownerUserId: userId })
        .returning({ id: repos.id, owner: repos.owner, repoName: repos.repoName })
      return row as { id: string; owner: string; repoName: string }
    }

    /** A quiet session whose `typed` messages were typed on `branch` of `repoId`. */
    const onBranch = async (
      projectId: string,
      now: Date,
      repoId: string,
      branch: string,
      typed = DEFAULT_MIN_NEW_USER_MESSAGES,
    ) => {
      const id = await session(projectId, {
        lastMessageAt: hoursBefore(now, 8),
        updatedAt: hoursBefore(now, 1),
        typed: 0,
      })
      for (let i = 0; i < typed; i += 1)
        await message(id, TYPED_AT, undefined, "message", {}, { repoId, gitBranch: branch })
      return id
    }

    test("SC17: only unlinked candidate sessions' non-default github.com branches are listed", async () => {
      const now = ist(11, 2)
      const due = await project({ autoReview: true })
      const a = await repo()
      const x1 = await onBranch(due, now, a.id, "feat/x")
      const x2 = await onBranch(due, now, a.id, "feat/x")
      await onBranch(due, now, a.id, "main")
      await onBranch(due, now, a.id, "master")
      await linkPullRequest(await onBranch(due, now, a.id, "feat/y"), "open")
      await onBranch(due, now, (await repo("gitlab.com")).id, "feat/z")
      await onBranch(due, now, a.id, "feat/w", 3)
      await onBranch(await project(), now, a.id, "feat/v")

      const listed = await branchesToLookUp(db, { ...DEFAULTS, now })

      expect(listed).toEqual([
        {
          repoId: a.id,
          owner: a.owner,
          repo: a.repoName,
          branch: "feat/x",
          sessionIds: [x1, x2].sort(),
        },
      ])
      expect(BRANCH_CHECK_LIMIT).toBe(200)
    })

    test("branches worked on most recently are listed first, so the cap leaves out the oldest", async () => {
      const now = ist(11, 2)
      const due = await project({ autoReview: true })
      const a = await repo()
      const old = await onBranch(due, now, a.id, "feat/old")
      await db
        .update(sessions)
        .set({ lastMessageAt: hoursBefore(now, 5 * 24) })
        .where(eq(sessions.id, old))
      await onBranch(due, now, a.id, "feat/new")

      const listed = await branchesToLookUp(db, { ...DEFAULTS, now })

      expect(listed.map((b) => b.branch)).toEqual(["feat/new", "feat/old"])
    })

    test("201 waiting branches list the 200 worked on most recently, leaving out the oldest", async () => {
      const now = ist(11, 2)
      const due = await project({ autoReview: true })
      const a = await repo()
      const branches = Array.from({ length: BRANCH_CHECK_LIMIT + 1 }, (_, i) => ({
        id: `capped-${i}`,
        branch: `feat/b${i}`,
        lastMessageAt: hoursBefore(now, 8 + i),
      }))
      await db.insert(sessions).values(
        branches.map((b) => ({
          id: b.id,
          source: "claude_code" as const,
          userId,
          projectId: due,
          lastMessageAt: b.lastMessageAt,
          updatedAt: hoursBefore(now, 1),
        })),
      )
      await db.insert(messages).values(
        branches.flatMap((b) =>
          Array.from({ length: DEFAULT_MIN_NEW_USER_MESSAGES }, (_, n) => ({
            sessionId: b.id,
            lineUuid: crypto.randomUUID(),
            subIndex: 0,
            msgType: "message" as const,
            role: "user" as const,
            trackId: "main",
            lineNumber: n + 1,
            raw: {},
            sourceSchemaVersion: 1,
            content: { type: "text", value: "hi" },
            timestamp: TYPED_AT,
            createdAt: TYPED_AT,
            repoId: a.id,
            gitBranch: b.branch,
          })),
        ),
      )

      const listed = await branchesToLookUp(db, { ...DEFAULTS, now })

      expect(listed.map((b) => b.branch)).toEqual(
        branches.slice(0, BRANCH_CHECK_LIMIT).map((b) => b.branch),
      )
    })

    test("a session linked only to a closed pull request is still listed, so a later merge on its branch is found", async () => {
      const now = ist(11, 2)
      const due = await project({ autoReview: true })
      const a = await repo()
      const reopened = await onBranch(due, now, a.id, "feat/q")
      await linkPullRequest(reopened, "closed")

      const listed = await branchesToLookUp(db, { ...DEFAULTS, now })

      expect(listed.map((b) => ({ branch: b.branch, sessionIds: b.sessionIds }))).toEqual([
        { branch: "feat/q", sessionIds: [reopened] },
      ])
    })
  })
  describe("sessions that grew after their review", () => {
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

    /** `count` user messages in the main conversation, a minute apart from `at`. */
    const userTurns = async (
      sessionId: string,
      at: Date,
      count = DEFAULT_MIN_NEW_USER_MESSAGES,
    ) => {
      for (let turn = 0; turn < count; turn += 1)
        await message(sessionId, new Date(at.getTime() + turn * 60_000))
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
      if (grew) await userTurns(id, hoursBefore(now, hours))
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

    test("SC3: a reviewed session needs 4 new user messages, not counting replies, tool calls or subagent prompts", async () => {
      const now = ist(11, 2)
      const on = await project({ autoReview: true })
      const grown = async (userMessages: number) => {
        const { id } = await reviewedQuiet(on, now, false)
        const at = hoursBefore(now, 8)
        await userTurns(id, at, userMessages)
        await message(id, at, at, "message", { role: "assistant" })
        await message(id, at, at, "message", { role: "assistant" })
        await message(id, at, at, "message", { trackId: "agent-1" })
        return id
      }
      const three = await grown(3)
      const four = await grown(4)

      await queueNightlyReviews(db, { ...DEFAULTS, now })

      expect(DEFAULT_MIN_NEW_USER_MESSAGES).toBe(4)
      expect(await waitingFor(three)).toEqual([])
      expect(await waitingFor(four)).toEqual([expect.objectContaining({ newPartOnly: true })])
    })

    test("the number of new user messages a re-review needs follows the setting", async () => {
      const now = ist(11, 2)
      const on = await project({ autoReview: true })
      const { id } = await reviewedQuiet(on, now, false)
      await userTurns(id, hoursBefore(now, 8), 1)

      await queueNightlyReviews(db, { ...DEFAULTS, now, minNewUserMessages: 1 })

      expect(await waitingFor(id)).toHaveLength(1)
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

    test("a failed review followed only by token reports, turn markers and custom lines is not retried", async () => {
      const now = ist(11, 2)
      const on = await project({ autoReview: true })
      const id = await quietSession(on, now, 8)
      await message(id, hoursBefore(now, 12))
      await run(id, on, { status: "failed", at: hoursBefore(now, 11) })
      await message(id, null, hoursBefore(now, 10), "usage")
      await message(id, hoursBefore(now, 9.5), hoursBefore(now, 9.5), "turnEvent")
      await message(id, null, hoursBefore(now, 9), "custom")

      await queueNightlyReviews(db, { ...DEFAULTS, now })

      expect(await waitingFor(id)).toEqual([])
    })

    test("SC12: for a reviewed session only a pull request merged after its last review counts", async () => {
      const now = ist(11, 2)
      const on = await project({ autoReview: true })
      const grownBusy = async () => {
        const id = await busySession(on, now)
        const read = await message(id, hoursBefore(now, 5))
        await run(id, on, { status: "done", at: hoursBefore(now, 3), lastMessageId: read })
        await userTurns(id, hoursBefore(now, 1))
        return id
      }
      const endedBefore = await grownBusy()
      await linkPullRequest(endedBefore, "merged", "github.com", hoursBefore(now, 4))
      const endedAfter = await grownBusy()
      await linkPullRequest(endedAfter, "merged", "github.com", hoursBefore(now, 2))

      await queueNightlyReviews(db, { ...DEFAULTS, now })

      expect(await waitingFor(endedBefore)).toEqual([])
      expect(await waitingFor(endedAfter)).toHaveLength(1)
    })

    test("SC9: a merged reviewed session goes ahead of a quiet never-reviewed one", async () => {
      const now = ist(11, 2)
      const on = await project({ autoReview: true })
      const prSession = await busySession(on, now)
      const read = await message(prSession, hoursBefore(now, 5))
      const done = await run(prSession, on, {
        status: "done",
        at: hoursBefore(now, 3),
        lastMessageId: read,
      })
      await userTurns(prSession, hoursBefore(now, 1))
      await linkPullRequest(prSession, "merged", "github.com", hoursBefore(now, 2))
      const neverReviewed = await quietSession(on, now, 8)

      await queueNightlyReviews(db, { ...DEFAULTS, limit: 1, now })

      expect(await waitingFor(prSession)).toEqual([
        expect.objectContaining({ newPartOnly: true, basedOn: done }),
      ])
      expect(await waitingFor(neverReviewed)).toEqual([])
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
        if (grew) await userTurns(id, hoursBefore(now, 1))
        return linkPullRequest(id, "open")
      }
      await reviewedBusy(false)
      const wanted = await reviewedBusy(true)

      const listed = await pullRequestsToCheck(db, { ...DEFAULTS, now })

      expect(listed.map((pr) => pr.id)).toEqual([wanted])
    })
  })
})
