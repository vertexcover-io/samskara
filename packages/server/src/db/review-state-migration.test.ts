import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { eq } from "drizzle-orm"
import type { Sql } from "postgres"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import type { Db } from "./client.js"
import { messages, projects, sessionReviews, sessions, users } from "./schema.js"
import { dockerAvailable, startTestDb } from "./testDb.js"

describe.skipIf(!dockerAvailable())("review state on sessionReviews", () => {
  let teardown: () => Promise<void>
  let db: Db
  let client: Sql

  beforeAll(async () => {
    const started = await startTestDb()
    db = started.db
    client = started.client
    teardown = started.teardown
  }, 120_000)

  afterAll(async () => {
    await teardown?.()
  })

  const backfill = () =>
    readFileSync(
      new URL("../../migrations/0041_review_state_backfill.sql", import.meta.url),
      "utf8",
    )
      .split("--> statement-breakpoint")
      .map((statement) => statement.trim())
      .filter((statement) => statement.length > 0)

  const runBackfill = () =>
    client.begin(async (tx) => {
      for (const statement of backfill()) await tx.unsafe(statement)
    })

  const seedSession = async () => {
    const [user] = await db
      .insert(users)
      .values({
        githubId: 700_000 + Math.floor(Math.random() * 1_000_000),
        githubLogin: "review-state-user",
      })
      .returning()
    if (!user) throw new Error("seed user failed")
    const [project] = await db
      .insert(projects)
      .values({ name: "review-state", slug: `review-state-${randomUUID()}`, ownerUserId: user.id })
      .returning()
    if (!project) throw new Error("seed project failed")
    const sessionId = `review-state-${randomUUID()}`
    await db
      .insert(sessions)
      .values({ id: sessionId, source: "claude_code", userId: user.id, projectId: project.id })
    return { sessionId, projectId: project.id }
  }

  const seedMessage = async (
    sessionId: string,
    lineNumber: number,
    createdAt: Date,
    trackId = "main",
  ) => {
    await db.insert(messages).values({
      sessionId,
      trackId,
      lineUuid: randomUUID(),
      subIndex: 0,
      msgType: "message",
      role: "user",
      content: { text: "hi" },
      lineNumber,
      raw: {},
      sourceSchemaVersion: 1,
      createdAt,
    })
  }

  const result = { outcome: "shipped", summary: "s", signals: {} }

  /** A raw insert, so the database itself decides what it accepts. */
  const insertReview = (values: Record<string, unknown>) =>
    client`insert into "sessionReviews" ${client(
      "signals" in values ? { ...values, signals: JSON.stringify(values.signals) } : values,
    )} returning *`

  test("SC1: a review saved with only its result reads back done, with no attempts, error, heartbeat or reviewedThrough", async () => {
    const { sessionId, projectId } = await seedSession()
    const [row] = await db
      .insert(sessionReviews)
      .values({ sessionId, projectId, analyzer: "heuristic-v1", ...result })
      .returning()

    expect(row).toMatchObject({
      status: "done",
      attempts: 0,
      error: null,
      heartbeatAt: null,
      reviewedThrough: null,
    })
  })

  test("SC1: a waiting review with no result is accepted", async () => {
    const { sessionId, projectId } = await seedSession()
    const [row] = await insertReview({
      sessionId,
      projectId,
      analyzer: "ai-problems-v2",
      status: "waiting",
    })

    expect(row).toMatchObject({ status: "waiting", outcome: null, summary: null, signals: null })
  })

  test.each([
    {
      name: "a done review with no outcome",
      values: { status: "done", summary: "s", signals: {} },
      constraint: "sessionReviews_done_has_result_check",
    },
    {
      name: "a status of paused",
      values: { status: "paused" },
      constraint: "sessionReviews_status_check",
    },
    {
      name: "an outcome of great",
      values: { ...result, outcome: "great" },
      constraint: "sessionReviews_outcome_check",
    },
  ])("SC1: the database refuses $name", async ({ values, constraint }) => {
    const { sessionId, projectId } = await seedSession()

    await expect(
      insertReview({ sessionId, projectId, analyzer: "heuristic-v1", ...values }),
    ).rejects.toMatchObject({ constraint_name: constraint })
  })

  test("SC2: the backfill records the last main-conversation line stored before each done review was saved, and replaying it changes nothing", async () => {
    const savedAt = new Date("2026-01-10T12:00:00Z")
    const before = new Date("2026-01-10T11:00:00Z")
    const after = new Date("2026-01-10T13:00:00Z")

    const a = await seedSession()
    for (const line of [1, 2, 3, 4, 5]) await seedMessage(a.sessionId, line, before)
    for (const line of [6, 7]) await seedMessage(a.sessionId, line, after)
    await seedMessage(a.sessionId, 40, before, "agent:a1")
    const [aDone] = await insertReview({
      sessionId: a.sessionId,
      projectId: a.projectId,
      analyzer: "heuristic-v1",
      ...result,
      updatedAt: savedAt.toISOString(),
    })
    const [aWaiting] = await insertReview({
      sessionId: a.sessionId,
      projectId: a.projectId,
      analyzer: "ai-problems-v2",
      status: "waiting",
      updatedAt: savedAt.toISOString(),
    })

    const b = await seedSession()
    const [bDone] = await insertReview({
      sessionId: b.sessionId,
      projectId: b.projectId,
      analyzer: "heuristic-v1",
      ...result,
      updatedAt: savedAt.toISOString(),
    })

    const read = async () => {
      const ids = [aDone?.id, aWaiting?.id, bDone?.id].map(String)
      return Promise.all(
        ids.map(async (id) => {
          const [row] = await db.select().from(sessionReviews).where(eq(sessionReviews.id, id))
          return row
        }),
      )
    }

    await runBackfill()
    const first = await read()
    await runBackfill()
    const second = await read()

    expect(first.map((row) => [row?.status, row?.reviewedThrough])).toEqual([
      ["done", 5],
      ["waiting", null],
      ["done", null],
    ])
    expect(second).toEqual(first)
  })
})
