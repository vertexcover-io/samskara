import { eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import type { Db } from "../db/client.js"
import { sessionReviews, users } from "../db/schema.js"
import { dockerAvailable, startTestDb } from "../db/testDb.js"
import * as projectsRepo from "./projects.repo.js"
import * as reviewsRepo from "./reviews.repo.js"
import * as sessionsRepo from "./sessions.repo.js"

describe.skipIf(!dockerAvailable())("reviews repository", () => {
  let teardown: () => Promise<void>
  let db: Db

  beforeAll(async () => {
    const started = await startTestDb()
    db = started.db
    teardown = started.teardown
  }, 120_000)

  afterAll(async () => {
    await teardown?.()
  })

  const seedSession = async (sessionId: string) => {
    const [user] = await db
      .insert(users)
      .values({
        githubId: 5100 + Math.floor(Math.random() * 1_000_000),
        githubLogin: `reviews-repo-${sessionId}`,
      })
      .returning()
    if (!user) throw new Error("seed user failed")
    const projectId = await projectsRepo.upsert(db, {
      identity: { name: sessionId, slug: `slug-${sessionId}` },
      ownerId: user.id,
    })
    await sessionsRepo.upsert(db, {
      id: sessionId,
      source: "claude_code",
      userId: user.id,
      projectId,
      fields: { title: "t" },
    })
    return { userId: user.id, projectId }
  }

  test("SC5: the page shows the latest done full run and the done new-part runs after it; failed and waiting runs never show", async () => {
    const sessionId = "review-chain"
    const { userId, projectId } = await seedSession(sessionId)
    const done = { outcome: "shipped", summary: "s", signals: {} }
    const run = async (
      name: string,
      minute: number,
      values: { status: string; newPartOnly?: boolean } & Partial<typeof done>,
    ) => {
      const [row] = await db
        .insert(sessionReviews)
        .values({
          sessionId,
          projectId,
          analyzer: "ai-problems-v2",
          summary: name,
          createdAt: new Date(Date.UTC(2026, 0, 1, 10, minute)),
          ...values,
        })
        .returning()
      if (!row) throw new Error(`seed ${name} failed`)
    }
    const shown = async () =>
      (await reviewsRepo.listReviewsForSession(db, userId, sessionId)).map((row) => row.summary)

    await run("A", 1, { ...done, summary: "A", status: "done" })
    await run("B", 2, { ...done, summary: "B", status: "done", newPartOnly: true })
    await run("C", 3, { ...done, summary: "C", status: "done", newPartOnly: true })
    await run("D", 4, { status: "failed" })
    expect(await shown()).toEqual(["C", "B", "A"])

    await run("E", 5, { ...done, summary: "E", status: "done" })
    await run("F", 6, { ...done, summary: "F", status: "done", newPartOnly: true })
    await run("G", 7, { status: "waiting", newPartOnly: true })
    expect(await shown()).toEqual(["F", "E"])
  })

  test("SC5: a failed AI review does not count as reviewed, so the batch tries the session again; once done it counts", async () => {
    const sessionId = "failed-ai-review"
    const { userId, projectId } = await seedSession(sessionId)
    const [failed] = await db
      .insert(sessionReviews)
      .values({
        sessionId,
        projectId,
        analyzer: "ai-problems-v2",
        status: "failed",
        error: "harness timed out",
      })
      .returning()
    if (!failed) throw new Error("seed review failed")
    const query = { userId, sessionId, analyzer: "ai-problems-v2" }

    expect(await reviewsRepo.hasReviewFrom(db, query)).toBe(false)
    expect(await reviewsRepo.getReview(db, failed.id)).toBeNull()

    await db
      .update(sessionReviews)
      .set({ status: "done", outcome: "shipped", summary: "s", signals: {}, error: null })
      .where(eq(sessionReviews.id, failed.id))

    expect(await reviewsRepo.hasReviewFrom(db, query)).toBe(true)
    expect(await reviewsRepo.getReview(db, failed.id)).toMatchObject({ status: "done" })
  })
})

describe("lastMessageRead", () => {
  const message = (id: string, trackId: string, lineNumber: number, timestamp: string | null) => ({
    id,
    trackId,
    lineNumber,
    timestamp,
  })
  const main9 = message("main-9", "main", 9, "2026-01-01T10:00:00.000Z")
  const sub2 = message("sub-2", "agent:a1", 2, "2026-01-01T10:05:00.000Z")
  const main10 = message("main-10", "main", 10, null)

  test.each([
    {
      name: "main line 9 at 10:00, a subagent's line 2 at 10:05 and an untimed main line 10",
      messages: [main9, sub2, main10],
      expected: "sub-2",
    },
    {
      name: "no timestamps: main lines 9 and 10 beside a subagent's line 40",
      messages: [
        message("main-9", "main", 9, null),
        message("sub-40", "agent:a1", 40, null),
        message("main-10", "main", 10, null),
      ],
      expected: "main-10",
    },
    { name: "no messages", messages: [], expected: null },
  ])("SC1: $name were read last at $expected", ({ messages, expected }) => {
    expect(reviewsRepo.lastMessageRead(messages)).toBe(expected)
  })
})
