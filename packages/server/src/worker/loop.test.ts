import { createLogger } from "@samskara/core"
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest"
import type { Db } from "../db/client.js"
import {
  learningRuns,
  projects,
  reviewProblems,
  sessionReviews,
  sessions,
  users,
} from "../db/schema.js"
import { dockerAvailable, startTestDb } from "../db/testDb.js"
import type { RunOutcome } from "../repositories/learnings.repo.js"
import { finishReview } from "../repositories/reviews.repo.js"
import type { ClaimedFixRun, ClaimedReview } from "../repositories/workQueue.repo.js"
import type { AiReviewResult } from "../services/ai-review/pipeline.js"
import { problemFixture, seedSession } from "../services/learnings/testFixtures.js"
import { createWorkLoop, fixRunner } from "./loop.js"

const ANALYZER = "ai-problems-v2"
const log = createLogger({ service: "loop-test", level: "silent" })

/** A promise the test settles by hand, so a fake review stays running until told. */
const gate = () => {
  let open: () => void = () => undefined
  const opened = new Promise<void>((resolve) => {
    open = resolve
  })
  return { opened, open }
}

const until = async (check: () => Promise<boolean>): Promise<void> => {
  for (let i = 0; i < 400; i += 1) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error("condition never held")
}

describe.skipIf(!dockerAvailable())("work loop: reviews", () => {
  let db: Db
  let teardown: () => Promise<void>

  beforeAll(async () => {
    const started = await startTestDb()
    db = started.db
    teardown = started.teardown
  }, 120_000)

  afterAll(async () => {
    await teardown?.()
  })

  let projectId: string

  beforeEach(async () => {
    await db.delete(sessionReviews)
    await db.delete(sessions)
    await db.delete(projects)
    await db.delete(users)
    const [user] = await db
      .insert(users)
      .values({ githubId: 4200, githubLogin: "loop-user" })
      .returning({ id: users.id })
    const [project] = await db
      .insert(projects)
      .values({ name: "L", slug: "l", ownerUserId: user?.id as string })
      .returning({ id: projects.id })
    projectId = project?.id as string
    await db.insert(sessions).values(
      Array.from({ length: 5 }, (_, i) => ({
        id: `loop-${i}`,
        source: "claude_code",
        userId: user?.id as string,
        projectId,
      })),
    )
  })

  const queue = async (count: number): Promise<void> => {
    await db.insert(sessionReviews).values(
      Array.from({ length: count }, (_, i) => ({
        sessionId: `loop-${i}`,
        projectId,
        analyzer: ANALYZER,
        status: "waiting",
        updatedAt: new Date(Date.UTC(2026, 0, 1, 0, i)),
      })),
    )
  }

  const statuses = async () =>
    (await db.select({ status: sessionReviews.status }).from(sessionReviews)).map(
      (row) => row.status,
    )

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

  test("SC8: the loop never runs more than 2 reviews at once", async () => {
    await queue(5)
    const gates: Array<ReturnType<typeof gate>> = []
    const loop = createWorkLoop({
      db,
      log,
      runReview: async (review) => {
        const held = gate()
        gates.push(held)
        await held.opened
        return succeed(review)
      },
    })

    await loop.tick()
    await loop.tick()
    await loop.tick()

    expect(gates).toHaveLength(2)
    expect((await statuses()).filter((status) => status === "running")).toHaveLength(2)

    gates[0]?.open()
    await until(async () => gates.length === 3)
    expect((await statuses()).filter((status) => status === "running")).toHaveLength(2)

    for (const held of gates) held.open()
    await until(async () => {
      for (const held of gates) held.open()
      return (await statuses()).every((status) => status === "done")
    })
    await loop.idle()
    expect(gates).toHaveLength(5)
  })

  test("SC9: a failing review is tried 3 times and then shows failed", async () => {
    await queue(1)
    let calls = 0
    const loop = createWorkLoop({
      db,
      log,
      runReview: async () => {
        calls += 1
        return { kind: "error", code: "harnessFailed", detail: { message: "boom" } }
      },
    })

    await loop.tick()
    await until(async () => (await statuses())[0] === "failed")
    await loop.idle()

    expect(calls).toBe(3)
    const [row] = await db.select().from(sessionReviews)
    expect(row).toMatchObject({ status: "failed", attempts: 3, error: "harnessFailed: boom" })
  })

  test("SC10: a review that throws counts as a failed try", async () => {
    await queue(1)
    let calls = 0
    const loop = createWorkLoop({
      db,
      log,
      runReview: async (review) => {
        calls += 1
        if (calls === 1) throw new Error("crash")
        return succeed(review)
      },
    })

    await loop.tick()
    await until(async () => (await statuses())[0] === "done")
    await loop.idle()

    expect(calls).toBe(2)
    const [row] = await db
      .select()
      .from(sessionReviews)
      .where(eq(sessionReviews.sessionId, "loop-0"))
    expect(row).toMatchObject({ status: "done", attempts: 2 })
  })

  test("a review left running by a try whose result could not be saved is run again on the next tick", async () => {
    await queue(1)
    await db.update(sessionReviews).set({ status: "running", attempts: 1 })
    const loop = createWorkLoop({ db, log, runReview: succeed })

    await loop.tick()
    await until(async () => (await statuses())[0] === "done")
    await loop.idle()

    const [row] = await db.select().from(sessionReviews)
    expect(row).toMatchObject({ status: "done", attempts: 2 })
  })

  test("a review killed by a stopping worker stays running for the next worker, and nothing new is claimed", async () => {
    await queue(3)
    const gates: Array<ReturnType<typeof gate>> = []
    const loop = createWorkLoop({
      db,
      log,
      runReview: async () => {
        const held = gate()
        gates.push(held)
        await held.opened
        return { kind: "error", code: "harnessFailed", detail: { message: "killed" } }
      },
    })

    await loop.tick()
    expect(gates).toHaveLength(2)
    loop.stop()
    for (const held of gates) held.open()
    await loop.idle()
    await loop.tick()
    await loop.idle()

    expect(gates).toHaveLength(2)
    const rows = await db.select().from(sessionReviews).orderBy(sessionReviews.sessionId)
    expect(rows.map((row) => [row.status, row.attempts])).toEqual([
      ["running", 1],
      ["running", 1],
      ["waiting", 0],
    ])
  })
})

describe.skipIf(!dockerAvailable())("work loop: fix runs", () => {
  let db: Db
  let teardown: () => Promise<void>
  let projectIds: string[]
  let userId: string

  beforeAll(async () => {
    const started = await startTestDb()
    db = started.db
    teardown = started.teardown
  }, 120_000)

  afterAll(async () => {
    await teardown?.()
  })

  beforeEach(async () => {
    await db.delete(learningRuns)
    await db.delete(reviewProblems)
    await db.delete(sessionReviews)
    await db.delete(sessions)
    await db.delete(projects)
    await db.delete(users)
    const [user] = await db
      .insert(users)
      .values({ githubId: 4500, githubLogin: "fix-loop-user" })
      .returning({ id: users.id })
    userId = user?.id as string
    const created = await db
      .insert(projects)
      .values([
        { name: "F1", slug: "f1", ownerUserId: user?.id as string },
        { name: "F2", slug: "f2", ownerUserId: user?.id as string },
      ])
      .returning({ id: projects.id })
    projectIds = created.map((row) => row.id)
  })

  const queueRuns = async (count: number): Promise<void> => {
    await db.insert(learningRuns).values(
      projectIds.slice(0, count).map((projectId, i) => ({
        projectId,
        status: "waiting",
        startedAt: new Date(Date.UTC(2026, 0, 1, 0, i)),
      })),
    )
  }

  const runs = () => db.select().from(learningRuns).orderBy(learningRuns.startedAt)

  const noReviews = async (): Promise<AiReviewResult> => {
    throw new Error("no review should run")
  }

  test("SC38: a fix run fails 3 times, then shows failed with its reason", async () => {
    await queueRuns(1)
    let calls = 0
    const loop = createWorkLoop({
      db,
      log,
      runReview: noReviews,
      runFixRun: async (): Promise<RunOutcome> => {
        calls += 1
        return { status: "failed", error: "snapshot failed" }
      },
    })

    await loop.tick()
    await until(async () => (await runs())[0]?.status === "failed")
    await loop.idle()

    expect(calls).toBe(3)
    const [row] = await runs()
    expect(row).toMatchObject({ status: "failed", attempts: 3, error: "snapshot failed" })
    expect(row?.finishedAt).not.toBeNull()
  })

  test("SC39: a successful fix run is saved done", async () => {
    await queueRuns(1)
    const loop = createWorkLoop({
      db,
      log,
      runReview: noReviews,
      runFixRun: async () => ({ status: "done" }),
    })

    await loop.tick()
    await until(async () => (await runs())[0]?.status === "done")
    await loop.idle()

    const [row] = await runs()
    expect(row).toMatchObject({ status: "done", attempts: 1, error: null })
    expect(row?.finishedAt).not.toBeNull()
  })

  test("SC41: only one fix run runs at a time", async () => {
    await queueRuns(2)
    const gates: Array<ReturnType<typeof gate>> = []
    const started: ClaimedFixRun[] = []
    const loop = createWorkLoop({
      db,
      log,
      runReview: noReviews,
      runFixRun: async (run) => {
        started.push(run)
        const held = gate()
        gates.push(held)
        await held.opened
        return { status: "done" }
      },
    })

    await loop.tick()
    await loop.tick()

    expect(started).toHaveLength(1)
    expect((await runs()).map((row) => row.status).sort()).toEqual(["running", "waiting"])

    gates[0]?.open()
    await until(async () => started.length === 2)
    gates[1]?.open()
    await until(async () => (await runs()).every((row) => row.status === "done"))
    await loop.idle()
  })

  test("a fix run left running by a try whose result could not be saved is run again on the next tick", async () => {
    await queueRuns(1)
    await db.update(learningRuns).set({ status: "running", attempts: 1 })
    const loop = createWorkLoop({
      db,
      log,
      runReview: noReviews,
      runFixRun: async () => ({ status: "done" }),
    })

    await loop.tick()
    await until(async () => (await runs())[0]?.status === "done")
    await loop.idle()

    expect((await runs())[0]).toMatchObject({ status: "done", attempts: 2 })
  })

  test("a fix run killed by a stopping worker stays running for the next worker", async () => {
    await queueRuns(2)
    const held = gate()
    const loop = createWorkLoop({
      db,
      log,
      runReview: noReviews,
      runFixRun: async () => {
        await held.opened
        return { status: "failed", error: "killed" }
      },
    })

    await loop.tick()
    loop.stop()
    held.open()
    await loop.idle()

    expect((await runs()).map((row) => `${row.status} ${row.attempts}`).sort()).toEqual([
      "running 1",
      "waiting 0",
    ])
  })

  test("a project with a problem no run has read and no run yet gets a fix run queued and run when due runs are on", async () => {
    const [due] = projectIds
    await seedSession(db, {
      sessionId: "due-session",
      projectId: due as string,
      userId,
      problems: [problemFixture("Unread")],
    })
    const ran: string[] = []
    const loop = createWorkLoop({
      db,
      log,
      runReview: noReviews,
      runFixRun: async (run) => {
        ran.push(run.projectId)
        return { status: "done" }
      },
      queueDue: true,
    })

    await loop.tick()
    await until(async () => (await runs())[0]?.status === "done")
    await loop.idle()

    expect(ran).toEqual([due])
  })

  test("the same due project gets no fix run when due runs are off", async () => {
    await seedSession(db, {
      sessionId: "due-session",
      projectId: projectIds[0] as string,
      userId,
      problems: [problemFixture("Unread")],
    })
    const loop = createWorkLoop({
      db,
      log,
      runReview: noReviews,
      runFixRun: async () => ({ status: "done" }),
    })

    await loop.tick()
    await loop.idle()

    expect(await runs()).toEqual([])
  })

  test("a fix run waiting for its project's running review starts on its own once that review finishes", async () => {
    const projectId = projectIds[0] as string
    await db
      .insert(sessions)
      .values({ id: "held-session", source: "claude_code", userId, projectId })
    await db
      .insert(sessionReviews)
      .values({ sessionId: "held-session", projectId, analyzer: ANALYZER, status: "waiting" })
    await db.insert(learningRuns).values({ projectId, status: "waiting", waitForReviews: true })
    const held = gate()
    const started: string[] = []
    const loop = createWorkLoop({
      db,
      log,
      runReview: async (review) => {
        await held.opened
        const saved = await finishReview(db, review.id, {
          outcome: "productive",
          summary: "ok",
          signals: {},
          lastMessageId: null,
        })
        return { kind: "ok", reviewId: saved.id, review: {} as never }
      },
      runFixRun: async (run) => {
        started.push(run.id)
        return { status: "done" }
      },
    })

    await loop.tick()
    expect(started).toEqual([])
    expect((await runs())[0]).toMatchObject({ status: "waiting" })

    held.open()
    await until(async () => (await runs())[0]?.status === "done")
    await loop.idle()

    expect(started).toHaveLength(1)
  })

  test("a loop with no fix-run runner leaves waiting fix runs alone", async () => {
    await queueRuns(1)
    const loop = createWorkLoop({ db, log, runReview: noReviews })

    await loop.tick()
    await loop.idle()

    expect((await runs())[0]).toMatchObject({ status: "waiting", attempts: 0 })
  })
})

describe("fix runner", () => {
  const run = (harnessPath: string | null): ClaimedFixRun => ({
    id: "run-1",
    projectId: "project-1",
    attempts: 1,
    harnessPath,
  })

  const capture = (serverHarness: { path: string } | undefined) => {
    const seen: Array<{ runId: string; harness: unknown }> = []
    const runFix = fixRunner({
      serverHarness,
      execute: async (claimed, harness) => {
        seen.push({ runId: claimed.id, harness })
        return { status: "done" }
      },
    })
    return { seen, runFix }
  }

  test("a run queued with a harness path runs on that path, not the server's harness", async () => {
    const { seen, runFix } = capture({ path: "/srv/server-harness" })
    expect(await runFix(run("/srv/yok"))).toEqual({ status: "done" })
    expect(seen).toEqual([{ runId: "run-1", harness: { path: "/srv/yok" } }])
  })

  test("a run queued with no harness path runs on the server's harness", async () => {
    const { seen, runFix } = capture({ path: "/srv/server-harness" })
    await runFix(run(null))
    expect(seen).toEqual([{ runId: "run-1", harness: { path: "/srv/server-harness" } }])
  })

  test("a run with no harness path on a server with no harness fails with the settings to set, running nothing", async () => {
    const { seen, runFix } = capture(undefined)
    expect(await runFix(run(null))).toEqual({
      status: "failed",
      error: "No harness for fix runs: set LEARNINGS_HARNESS_REPO or LEARNINGS_HARNESS_PATH.",
    })
    expect(seen).toEqual([])
  })
})
