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

  const seedSession = async (sessionId: string, githubId = 5100) => {
    const [user] = await db
      .insert(users)
      .values({ githubId, githubLogin: `reviews-repo-user-${githubId}` })
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

  test("saving a review of a session moved to another project moves its review row there too", async () => {
    const sessionId = "moved-session"
    const { userId, projectId } = await seedSession(sessionId, 5101)
    const [row] = await db
      .insert(sessionReviews)
      .values({ sessionId, projectId, analyzer: "ai-problems-v2", status: "running" })
      .returning()
    const moved = await projectsRepo.upsert(db, {
      identity: { name: "moved", slug: "slug-moved" },
      ownerId: userId,
    })

    const saved = await reviewsRepo.upsertReview(db, {
      sessionId,
      projectId: moved,
      analyzer: "ai-problems-v2",
      outcome: "shipped",
      summary: "s",
      signals: {},
      reviewedThrough: 4,
    })

    expect(saved.id).toBe(row?.id)
    expect(saved.projectId).toBe(moved)
  })
})

describe("lastLineRead", () => {
  const main = (lineNumber: number) => ({ lineNumber, trackId: "main" })
  const subagent = (lineNumber: number) => ({ lineNumber, trackId: "agent:a1" })

  test.each([
    { name: "main lines 3, 9 and 4", messages: [main(3), main(9), main(4)], expected: 9 },
    {
      name: "main lines up to 5 beside a subagent's line 40",
      messages: [main(4), subagent(40), main(5)],
      expected: 5,
    },
    { name: "only a subagent's lines", messages: [subagent(12)], expected: null },
    { name: "no messages", messages: [], expected: null },
  ])("SC7: $name were read through main line $expected", ({ messages, expected }) => {
    expect(reviewsRepo.lastLineRead(messages)).toBe(expected)
  })
})
