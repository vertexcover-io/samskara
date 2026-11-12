import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest"
import { buildApp } from "../app.js"
import type { Db } from "../db/client.js"
import { messages, projects, sessionReviews, sessions, users } from "../db/schema.js"
import { dockerAvailable, startTestDb } from "../db/testDb.js"
import type { Env } from "../lib/env.js"
import { signToken } from "../lib/jwt.js"

const env: Env = {
  githubClientId: "id",
  githubClientSecret: "secret",
  publicBaseUrl: "http://localhost:3000",
  webBaseUrl: "http://localhost:8000",
  cookieSecure: false,
  jwtSecret: "test-secret-value",
  jwtExpiresIn: "7d",
  superAdminLogins: [],
  localLoginSecret: "",
  localLoginLogin: "samskara-dev",
  aiReviewModel: "zai-coding-plan/glm-5.3",
  aiReviewHarness: "opencode",
  aiReviewTimeoutMs: 600000,
}

// Runs against a local Postgres when DATABASE_URL is set (no Docker involved), else a
// testcontainers container when Docker is up, else skips.
describe.skipIf(!dockerAvailable())("reviews", () => {
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

  let userId: string
  let projectId: string
  const sessionId = "review-test-session"

  beforeEach(async () => {
    await db.delete(sessionReviews)
    await db.delete(messages)
    await db.delete(sessions)
    await db.delete(projects)
    await db.delete(users)
    const [user] = await db
      .insert(users)
      .values({ githubId: 1, githubLogin: "dev" })
      .returning({ id: users.id })
    userId = user?.id as string
    const [project] = await db
      .insert(projects)
      .values({ name: "P", slug: "p", ownerUserId: userId })
      .returning({ id: projects.id })
    projectId = project?.id as string
    await db.insert(sessions).values({
      id: sessionId,
      source: "claude_code",
      userId,
      projectId,
      title: "flaily session",
    })
  })

  const request = async (
    path: string,
    init: { readonly method?: string; readonly body?: unknown } = {},
  ): Promise<Response> => {
    const token = await signToken(env, { sub: userId, aud: "web" })
    return buildApp(db, env).request(path, {
      method: init.method ?? "GET",
      headers: {
        cookie: `session=${token}`,
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    })
  }

  test("V10: reviews of a session in a project the viewer cannot see stay invisible", async () => {
    const [stranger] = await db
      .insert(users)
      .values({ githubId: 4, githubLogin: "review-owner" })
      .returning({ id: users.id })
    const [hidden] = await db
      .insert(projects)
      .values({ name: "Hidden", slug: "hidden", ownerUserId: stranger?.id as string })
      .returning({ id: projects.id })
    const hiddenSessionId = "hidden-review-session"
    await db.insert(sessions).values({
      id: hiddenSessionId,
      source: "claude_code",
      userId: stranger?.id as string,
      projectId: hidden?.id as string,
      title: "hidden session",
    })
    await db.insert(sessionReviews).values({
      sessionId: hiddenSessionId,
      projectId: hidden?.id as string,
      analyzer: "heuristic-v1",
      outcome: "shipped",
      summary: "shipped: 1 turn, 1 commit",
      signals: {},
    })

    const mine = await request(`/api/sessions/${hiddenSessionId}/review`)
    expect(mine.status).toBe(200)
    const body = (await mine.json()) as { reviews: { summary: string }[] }
    expect(body.reviews).toHaveLength(0)

    // The owner still reads their own review — scoping must not over-block.
    const strangerToken = await signToken(env, { sub: stranger?.id as string, aud: "web" })
    const own = await buildApp(db, env).request(`/api/sessions/${hiddenSessionId}/review`, {
      headers: { cookie: `session=${strangerToken}` },
    })
    expect(own.status).toBe(200)
    const ownBody = (await own.json()) as { reviews: { summary: string }[] }
    expect(ownBody.reviews).toHaveLength(1)
  })

  test("SC3: a waiting AI review and a failed static review show no result; the waiting one shows as a job", async () => {
    await db.insert(sessionReviews).values([
      { sessionId, projectId, analyzer: "ai-problems-v2", status: "waiting" },
      { sessionId, projectId, analyzer: "heuristic-v1", status: "failed", error: "boom" },
    ])

    const listed = await request(`/api/sessions/${sessionId}/review`)
    expect(listed.status).toBe(200)
    expect(await listed.json()).toEqual({ reviews: [] })

    const ai = await request(`/api/sessions/${sessionId}/aireview`)
    expect(ai.status).toBe(200)
    expect(await ai.json()).toMatchObject({ review: null, job: { status: "running" } })
  })

  test("an AI review lists analyzedAt as its own recorded finish time, not the row's updatedAt", async () => {
    await db.insert(sessionReviews).values({
      sessionId,
      projectId,
      analyzer: "ai-problems-v2",
      status: "done",
      outcome: "productive",
      summary: "The earlier result.",
      signals: { run: { finishedAt: "2026-11-11T13:22:28.736Z" } },
      updatedAt: new Date("2026-11-11T13:32:49.531Z"),
    })

    const listed = await request(`/api/sessions/${sessionId}/review`)

    const body = (await listed.json()) as { reviews: { analyzedAt: string }[] }
    expect(body.reviews.map((review) => review.analyzedAt)).toEqual(["2026-11-11T13:22:28.736Z"])
  })
})
