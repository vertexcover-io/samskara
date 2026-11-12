import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { asc, eq } from "drizzle-orm"
import type { Sql } from "postgres"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import type { Db } from "./client.js"
import { messages, projects, reviewProblems, sessionReviews, sessions, users } from "./schema.js"
import { dockerAvailable, startTestDb } from "./testDb.js"

describe.skipIf(!dockerAvailable())("the review runs migration", () => {
  let teardown: () => Promise<void>
  let db: Db
  let client: Sql

  beforeAll(async () => {
    const started = await startTestDb()
    db = started.db
    client = started.client
    teardown = started.teardown
    // 0048 drops reviewedThrough; put it back so 0047 runs against the shape it was written for.
    await client`alter table "sessionReviews" add column if not exists "reviewedThrough" integer`
  }, 120_000)

  afterAll(async () => {
    await teardown?.()
  })

  const backfill = () =>
    client.begin(async (tx) => {
      const file = readFileSync(
        new URL("../../migrations/0047_review_runs_backfill.sql", import.meta.url),
        "utf8",
      )
      for (const statement of file.split("--> statement-breakpoint")) {
        if (statement.trim().length > 0) await tx.unsafe(statement)
      }
    })

  const seedSession = async () => {
    const [user] = await db
      .insert(users)
      .values({
        githubId: 700_000 + Math.floor(Math.random() * 1_000_000),
        githubLogin: "review-runs-user",
      })
      .returning()
    if (!user) throw new Error("seed user failed")
    const [project] = await db
      .insert(projects)
      .values({ name: "review-runs", slug: `review-runs-${randomUUID()}`, ownerUserId: user.id })
      .returning()
    if (!project) throw new Error("seed project failed")
    const sessionId = `review-runs-${randomUUID()}`
    await db
      .insert(sessions)
      .values({ id: sessionId, source: "claude_code", userId: user.id, projectId: project.id })
    return { sessionId, projectId: project.id }
  }

  const seedMessage = async (sessionId: string, lineNumber: number, subIndex: number) => {
    const [row] = await db
      .insert(messages)
      .values({
        sessionId,
        lineUuid: randomUUID(),
        subIndex,
        msgType: "message",
        role: "user",
        content: { text: "hi" },
        lineNumber,
        raw: {},
        sourceSchemaVersion: 1,
      })
      .returning({ id: messages.id })
    if (!row) throw new Error("seed message failed")
    return row.id
  }

  const result = { outcome: "shipped", summary: "s", signals: JSON.stringify({}) }
  const savedAt = "2026-01-01T10:00:00.000Z"

  /** A raw insert, so the old column and the database's own checks decide what is accepted. */
  const insertReview = async (values: Record<string, unknown>) => {
    const [row] = await client`insert into "sessionReviews" ${client(values)} returning "id"`
    if (!row) throw new Error("seed review failed")
    return String(row.id)
  }

  const runsOf = (sessionId: string) =>
    db
      .select()
      .from(sessionReviews)
      .where(eq(sessionReviews.sessionId, sessionId))
      .orderBy(asc(sessionReviews.createdAt))

  test("SC7: a carried result stays done on its row, the redo's state moves to a new row, and reviewedThrough becomes the line's last message", async () => {
    const failed = await seedSession()
    const failedId = await insertReview({
      sessionId: failed.sessionId,
      projectId: failed.projectId,
      analyzer: "ai-problems-v2",
      ...result,
      status: "failed",
      attempts: 3,
      error: "harness timed out",
      createdAt: "2026-01-01T09:00:00.000Z",
      updatedAt: savedAt,
    })
    await db.insert(reviewProblems).values({
      reviewId: failedId,
      sessionId: failed.sessionId,
      projectId: failed.projectId,
      position: 0,
      title: "kept",
      class: "missed",
      severity: "low",
      severityReason: "r",
      fixType: "code",
      description: "d",
      evidence: [],
      learning: "l",
    })
    const running = await seedSession()
    const runningId = await insertReview({
      sessionId: running.sessionId,
      projectId: running.projectId,
      analyzer: "ai-problems-v2",
      ...result,
      status: "running",
      attempts: 1,
      createdAt: "2026-01-01T09:00:00.000Z",
      updatedAt: savedAt,
    })
    const done = await seedSession()
    await seedMessage(done.sessionId, 6, 0)
    await seedMessage(done.sessionId, 7, 0)
    const lastOfLine7 = await seedMessage(done.sessionId, 7, 1)
    const doneId = await insertReview({
      sessionId: done.sessionId,
      projectId: done.projectId,
      analyzer: "ai-problems-v2",
      ...result,
      reviewedThrough: 7,
    })
    const plain = await seedSession()
    const resultOnlyId = await insertReview({
      sessionId: plain.sessionId,
      projectId: plain.projectId,
      analyzer: "ai-problems-v2",
      ...result,
    })
    const waitingId = await insertReview({
      sessionId: plain.sessionId,
      projectId: plain.projectId,
      analyzer: "heuristic-v1",
      status: "waiting",
    })

    await backfill()

    const failedRuns = await runsOf(failed.sessionId)
    expect(failedRuns.map((r) => [r.id === failedId, r.status, r.outcome, r.error])).toEqual([
      [true, "done", "shipped", null],
      [false, "failed", null, "harness timed out"],
    ])
    expect(failedRuns[1]?.attempts).toBe(3)
    expect(failedRuns[1]?.createdAt.getTime()).toBeGreaterThan(
      failedRuns[0]?.createdAt.getTime() ?? 0,
    )
    const kept = await db.select().from(reviewProblems).where(eq(reviewProblems.reviewId, failedId))
    expect(kept.map((p) => p.title)).toEqual(["kept"])

    const runningRuns = await runsOf(running.sessionId)
    expect(runningRuns.map((r) => [r.id === runningId, r.status, r.outcome])).toEqual([
      [true, "done", "shipped"],
      [false, "waiting", null],
    ])

    const [doneRun] = await runsOf(done.sessionId)
    expect(doneRun).toMatchObject({ id: doneId, status: "done", lastMessageId: lastOfLine7 })

    const [resultOnly] = await db
      .select()
      .from(sessionReviews)
      .where(eq(sessionReviews.id, resultOnlyId))
    expect(resultOnly).toMatchObject({
      status: "done",
      attempts: 0,
      error: null,
      newPartOnly: false,
    })
    const [waiting] = await db.select().from(sessionReviews).where(eq(sessionReviews.id, waitingId))
    expect(waiting).toMatchObject({ status: "waiting", outcome: null })

    const doubled = await client`
      select "sessionId", "analyzer" from "sessionReviews"
      where "status" in ('waiting', 'running')
      group by "sessionId", "analyzer" having count(*) > 1`
    expect(doubled).toEqual([])
  })
})
