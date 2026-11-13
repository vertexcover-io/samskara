import { eq } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest"
import type { Db } from "../db/client.js"
import { learningRuns, projects, reviewProblems, sessionReviews, users } from "../db/schema.js"
import { dockerAvailable, startTestDb } from "../db/testDb.js"
import {
  problemFixture,
  seedOrg,
  seedProject,
  seedSession,
} from "../services/learnings/testFixtures.js"
import {
  claimFixRun,
  queueDueFixRuns,
  queueFixRun,
  requeueRunningFixRuns,
} from "./workQueue.repo.js"

const DAY_MS = 24 * 60 * 60 * 1000
const daysAgo = (days: number): Date => new Date(Date.now() - days * DAY_MS)

describe.skipIf(!dockerAvailable())("work queue: fix runs", () => {
  let db: Db
  let teardown: () => Promise<void>
  let userId: string
  let orgId: string
  let counter = 0

  beforeAll(async () => {
    const started = await startTestDb()
    db = started.db
    teardown = started.teardown
    const [user] = await db
      .insert(users)
      .values({ githubId: 4400, githubLogin: "fix-queue-user" })
      .returning({ id: users.id })
    userId = user?.id as string
  }, 120_000)

  afterAll(async () => {
    await teardown?.()
  })

  beforeEach(async () => {
    await db.delete(learningRuns)
    await db.delete(reviewProblems)
    await db.delete(sessionReviews)
    counter += 1
    orgId = await seedOrg(db, `fix-org-${counter}`)
  })

  const project = (name: string): Promise<string> => seedProject(db, orgId, `${name}-${counter}`)

  /** A session in the project whose finished review holds one problem no run has read. */
  const withUnreadProblem = async (projectId: string): Promise<void> => {
    counter += 1
    await seedSession(db, {
      sessionId: `fix-session-${counter}`,
      projectId,
      userId,
      problems: [problemFixture("Unread")],
    })
  }

  const review = async (projectId: string, status: string): Promise<void> => {
    counter += 1
    await seedSession(db, { sessionId: `rev-session-${counter}`, projectId, userId, problems: [] })
    await db
      .update(sessionReviews)
      .set({
        status,
        ...(status === "done" ? {} : { outcome: null, summary: null, signals: null }),
      })
      .where(eq(sessionReviews.sessionId, `rev-session-${counter}`))
  }

  const run = async (projectId: string, values: Partial<typeof learningRuns.$inferInsert>) => {
    const [row] = await db
      .insert(learningRuns)
      .values({ projectId, ...values })
      .returning()
    if (row === undefined) throw new Error("seed run failed")
    return row
  }

  const runById = async (id: string) => {
    const [row] = await db.select().from(learningRuns).where(eq(learningRuns.id, id))
    return row
  }

  test("SC34: a worker start puts running fix runs back to waiting", async () => {
    const p = await project("p")
    const q = await project("q")
    const running = await run(p, { status: "running", attempts: 1 })
    const done = await run(q, { status: "done", finishedAt: new Date() })

    expect(await requeueRunningFixRuns(db)).toBe(1)

    expect(await runById(running.id)).toMatchObject({ status: "waiting", attempts: 1 })
    expect(await runById(done.id)).toMatchObject({ status: "done" })
  })

  test("a worker start fails a running fix run that was on its 3rd try instead of trying a 4th", async () => {
    const last = await run(await project("p"), { status: "running", attempts: 3 })
    const second = await run(await project("q"), { status: "running", attempts: 2 })

    expect(await requeueRunningFixRuns(db)).toBe(2)

    const failed = await runById(last.id)
    expect(failed).toMatchObject({
      status: "failed",
      attempts: 3,
      error: "The worker stopped during the last try.",
    })
    expect(failed?.finishedAt).not.toBeNull()
    expect(await runById(second.id)).toMatchObject({ status: "waiting", attempts: 2 })
  })

  test("a worker start fails a running fix run on the configured last try", async () => {
    const second = await run(await project("p"), { status: "running", attempts: 2 })

    expect(await requeueRunningFixRuns(db, [], 2)).toBe(1)

    expect(await runById(second.id)).toMatchObject({ status: "failed", attempts: 2 })
  })

  test("SC35: a fix run that waits is not claimed while its project has a review waiting or running", async () => {
    const p = await project("p")
    const waiting = await run(p, { status: "waiting", waitForReviews: true })
    await review(p, "running")

    expect(await claimFixRun(db)).toBeNull()

    await db.update(sessionReviews).set({ status: "waiting" })
    expect(await claimFixRun(db)).toBeNull()

    await db
      .update(sessionReviews)
      .set({ status: "done", outcome: "productive", summary: "s", signals: {} })
    expect(await claimFixRun(db)).toMatchObject({ id: waiting.id, projectId: p, attempts: 1 })
  })

  test("SC36: a failed review does not hold a fix run back", async () => {
    const p = await project("p")
    const waiting = await run(p, { status: "waiting", waitForReviews: true })
    await review(p, "failed")

    expect(await claimFixRun(db)).toMatchObject({ id: waiting.id })
  })

  test("SC37: a fix run that does not wait is claimed while reviews run", async () => {
    const p = await project("p")
    const waiting = await run(p, { status: "waiting", waitForReviews: false })
    await review(p, "running")

    expect(await claimFixRun(db)).toMatchObject({ id: waiting.id, attempts: 1 })
    expect(await runById(waiting.id)).toMatchObject({ status: "running", attempts: 1 })
  })

  test("SC37: another project's running review does not hold a fix run back", async () => {
    const p = await project("p")
    const other = await project("other")
    const waiting = await run(p, { status: "waiting", waitForReviews: true })
    await review(other, "running")

    expect(await claimFixRun(db)).toMatchObject({ id: waiting.id })
  })

  test("SC40: a project is queued once its last run is older than its N days", async () => {
    const a = await project("a")
    const b = await project("b")
    const c = await project("c")
    const d = await project("d")
    const e = await project("e")
    const f = await project("f")
    for (const id of [a, b, c, d, f]) await withUnreadProblem(id)
    await db.update(projects).set({ fixRunEveryDays: 2 }).where(eq(projects.id, c))
    await run(a, { status: "done", startedAt: daysAgo(8), finishedAt: daysAgo(8) })
    await run(b, { status: "done", startedAt: daysAgo(3), finishedAt: daysAgo(3) })
    await run(c, { status: "done", startedAt: daysAgo(3), finishedAt: daysAgo(3) })
    await run(e, { status: "done", startedAt: daysAgo(30), finishedAt: daysAgo(30) })
    const fWaiting = await run(f, { status: "waiting", startedAt: daysAgo(30) })

    expect(await queueDueFixRuns(db)).toBe(3)

    const open = await db.select().from(learningRuns).where(eq(learningRuns.status, "waiting"))
    expect(open.map((row) => row.projectId).sort()).toEqual([a, c, d, f].sort())
    expect(open.filter((row) => row.id !== fWaiting.id).every((row) => row.waitForReviews)).toBe(
      true,
    )
    expect(await queueDueFixRuns(db)).toBe(0)
  })

  test("queueFixRun from a caller with no harness path keeps the path the waiting run was queued with", async () => {
    const p = await project("p")
    const first = await queueFixRun(db, {
      projectId: p,
      waitForReviews: true,
      harnessPath: "/srv/yok",
    })
    await queueFixRun(db, { projectId: p, waitForReviews: false, harnessPath: null })

    expect(await runById(first?.id as string)).toMatchObject({
      status: "waiting",
      waitForReviews: false,
      harnessPath: "/srv/yok",
    })
  })

  test("queueFixRun queues once per project and updates the waiting run with the caller's choice", async () => {
    const p = await project("p")
    const first = await queueFixRun(db, { projectId: p, waitForReviews: true, harnessPath: null })
    const again = await queueFixRun(db, {
      projectId: p,
      waitForReviews: false,
      harnessPath: "/srv/yok",
    })

    expect(again).toEqual(first)
    expect(await runById(first?.id as string)).toMatchObject({
      status: "waiting",
      waitForReviews: false,
      harnessPath: "/srv/yok",
    })

    await db.update(learningRuns).set({ status: "running" })
    expect(
      await queueFixRun(db, { projectId: p, waitForReviews: true, harnessPath: null }),
    ).toBeNull()
  })
})
