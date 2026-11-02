import type { Problem } from "@samskara/core"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import type { Db } from "../db/client.js"
import { users } from "../db/schema.js"
import { dockerAvailable, startTestDb } from "../db/testDb.js"
import * as projectsRepo from "./projects.repo.js"
import * as problemsRepo from "./reviewProblems.repo.js"
import * as reviewsRepo from "./reviews.repo.js"
import * as sessionsRepo from "./sessions.repo.js"

const problem = (title: string): Problem => ({
  title,
  class: "missed",
  severity: "high",
  severityReason: "a wrong result would ship",
  fixType: "skill",
  description: "Expected a test run. None happened.",
  evidence: [{ from: "msg-1", to: "msg-2", quote: "all tests pass", why: "no test ran" }],
  learning: "Run the tests first.",
  extra: { stage: "coder" },
})

describe.skipIf(!dockerAvailable())("review problems repository", () => {
  let teardown: () => Promise<void>
  let db: Db
  let counter = 0

  const seedReview = async (sessionId: string) => {
    counter += 1
    const [user] = await db
      .insert(users)
      .values({ githubId: 9000 + counter, githubLogin: `problems-user-${counter}` })
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
    const review = await reviewsRepo.upsertReview(db, {
      sessionId,
      projectId,
      analyzer: "ai-problems-v2",
      outcome: "shipped",
      friction: "none",
      summary: "s",
      signals: {},
    })
    return { userId: user.id, projectId, reviewId: review.id }
  }

  beforeAll(async () => {
    const started = await startTestDb()
    db = started.db
    teardown = started.teardown
  }, 120_000)

  afterAll(async () => {
    await teardown?.()
  })

  test("RP-DB1: a review's problems are saved in order, every field kept", async () => {
    const { userId, projectId, reviewId } = await seedReview("problems-1")
    await problemsRepo.replaceReviewProblems(db, {
      reviewId,
      sessionId: "problems-1",
      projectId,
      problems: [problem("First"), problem("Second")],
    })
    const rows = await problemsRepo.listProblemsForSession(db, userId, "problems-1")
    expect(rows.map((row) => row.title)).toEqual(["First", "Second"])
    expect(rows[0]).toMatchObject({
      reviewId,
      class: "missed",
      severity: "high",
      severityReason: "a wrong result would ship",
      fixType: "skill",
      description: "Expected a test run. None happened.",
      evidence: [{ from: "msg-1", to: "msg-2", quote: "all tests pass", why: "no test ran" }],
      learning: "Run the tests first.",
      extra: { stage: "coder" },
    })
  })

  test("RP-DB2: redoing a review replaces its problems instead of adding to them", async () => {
    const { userId, projectId, reviewId } = await seedReview("problems-2")
    const input = { reviewId, sessionId: "problems-2", projectId }
    await problemsRepo.replaceReviewProblems(db, { ...input, problems: [problem("Old")] })
    await problemsRepo.replaceReviewProblems(db, { ...input, problems: [problem("New")] })
    const rows = await problemsRepo.listProblemsForSession(db, userId, "problems-2")
    expect(rows.map((row) => row.title)).toEqual(["New"])
  })

  test("RP-DB3: the same problem in two sessions is two rows, never merged", async () => {
    const a = await seedReview("problems-3a")
    const b = await seedReview("problems-3b")
    for (const [seeded, sessionId] of [
      [a, "problems-3a"],
      [b, "problems-3b"],
    ] as const)
      await problemsRepo.replaceReviewProblems(db, {
        reviewId: seeded.reviewId,
        sessionId,
        projectId: seeded.projectId,
        problems: [problem("Same title")],
      })
    expect(await problemsRepo.listProblemsForSession(db, a.userId, "problems-3a")).toHaveLength(1)
    expect(await problemsRepo.listProblemsForSession(db, b.userId, "problems-3b")).toHaveLength(1)
  })

  test("RP-DB4: a user who cannot see the session sees none of its problems", async () => {
    const { projectId, reviewId } = await seedReview("problems-4")
    await problemsRepo.replaceReviewProblems(db, {
      reviewId,
      sessionId: "problems-4",
      projectId,
      problems: [problem("Hidden")],
    })
    const stranger = await seedReview("problems-4-other")
    expect(await problemsRepo.listProblemsForSession(db, stranger.userId, "problems-4")).toEqual([])
  })

  test("RP-DB5: given a review id, only that review's problems come back", async () => {
    const { userId, projectId, reviewId } = await seedReview("problems-5")
    const other = await reviewsRepo.upsertReview(db, {
      sessionId: "problems-5",
      projectId,
      analyzer: "ai-v1",
      outcome: "shipped",
      friction: "none",
      summary: "s",
      signals: {},
    })
    const input = { sessionId: "problems-5", projectId }
    await problemsRepo.replaceReviewProblems(db, {
      ...input,
      reviewId,
      problems: [problem("Mine")],
    })
    await problemsRepo.replaceReviewProblems(db, {
      ...input,
      reviewId: other.id,
      problems: [problem("Other")],
    })
    const rows = await problemsRepo.listProblemsForSession(db, userId, "problems-5", reviewId)
    expect(rows.map((row) => row.title)).toEqual(["Mine"])
    expect(await problemsRepo.listProblemsForSession(db, userId, "problems-5")).toHaveLength(2)
  })
})
