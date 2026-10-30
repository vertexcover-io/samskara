import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest"
import { buildApp } from "../app.js"
import type { Db } from "../db/client.js"
import {
  messages,
  projects,
  sessionReviews,
  sessions,
  userProjectGrant,
  users,
} from "../db/schema.js"
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

  const line = async (
    sid: string,
    lineNumber: number,
    msgType: string,
    role: string | null,
    content: unknown,
    details: unknown,
  ) => {
    await db.insert(messages).values({
      sessionId: sid,
      lineUuid: crypto.randomUUID(),
      subIndex: 0,
      msgType,
      role,
      lineNumber,
      source: "claude_code",
      sourceRelativePath: "test.jsonl",
      trackId: "main",
      raw: {},
      sourceSchemaVersion: 1,
      content,
      details,
    })
  }

  /** A session with a clean Bash error loop: 3 failures after one prompt. */
  const seedErrorLoop = async () => {
    await line(sessionId, 1, "message", "user", { type: "text", value: "fix the build" }, {})
    for (let i = 0; i < 3; i += 1) {
      const callId = `call-${i}`
      await line(sessionId, 2 + i * 2, "toolCall", null, null, {
        callId,
        name: "Bash",
        input: { command: "npm test" },
      })
      await line(sessionId, 3 + i * 2, "toolResult", null, null, {
        callId,
        output: "",
        status: "failure",
      })
    }
  }

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

  test("V1: POST /api/sessions/:id/review persists a review with the error loop visible", async () => {
    await seedErrorLoop()
    const res = await request(`/api/sessions/${sessionId}/review`, { method: "POST" })
    expect(res.status).toBe(201)
    const body = (await res.json()) as {
      reviewId: string
      review: { outcome: string; friction: string; signals: { errorLoops: unknown[] } }
    }
    expect(body.review.outcome).toBe("struggled")
    expect(body.review.friction).toBe("high")
    expect(body.review.signals.errorLoops).toHaveLength(1)
  })

  test("V2: re-review replaces the review row instead of stacking", async () => {
    await seedErrorLoop()
    const first = await request(`/api/sessions/${sessionId}/review`, { method: "POST" })
    const second = await request(`/api/sessions/${sessionId}/review`, { method: "POST" })
    expect(second.status).toBe(201)
    const listed = await request(`/api/sessions/${sessionId}/review`)
    const body = (await listed.json()) as { reviews: unknown[] }
    expect(body.reviews).toHaveLength(1)
    void first
  })

  test("V6: reviewing a missing session returns 404", async () => {
    const res = await request("/api/sessions/does-not-exist/review", { method: "POST" })
    expect(res.status).toBe(404)
  })

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
      friction: "none",
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

  test("V14: a viewer cannot run the static review — it writes the review", async () => {
    await seedErrorLoop()
    const [stranger] = await db
      .insert(users)
      .values({ githubId: 4, githubLogin: "viewer-static" })
      .returning({ id: users.id })
    await db
      .insert(userProjectGrant)
      .values({ userId: stranger?.id as string, projectId, scope: "viewer" })
    const strangerToken = await signToken(env, { sub: stranger?.id as string, aud: "web" })

    const res = await buildApp(db, env).request(`/api/sessions/${sessionId}/review`, {
      method: "POST",
      headers: { cookie: `session=${strangerToken}` },
    })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: "notEditable" })
    // Nothing was written on the way to the refusal.
    expect(await db.select().from(sessionReviews)).toHaveLength(0)
  })
})
