import pino from "pino"
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest"
import { buildApp } from "../app.js"
import type { Db } from "../db/client.js"
import { projects, sessionReviews, sessions, userProjectGrant, users } from "../db/schema.js"
import { dockerAvailable, startTestDb } from "../db/testDb.js"
import type { Env } from "../lib/env.js"
import { signToken } from "../lib/jwt.js"
import { PROBLEMS_ANALYZER } from "../services/ai-review/pipeline.js"

const CREDENTIAL_ENV = { OPENCODE_API_KEY: "oc-key", CLAUDE_CODE_OAUTH_TOKEN: "cc-token" }

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
  aiReviewModel: "fake-model",
  aiReviewHarness: "opencode",
  aiReviewTimeoutMs: 600000,
}

const silentLog = pino({ level: "silent" })

describe.skipIf(!dockerAvailable())("review batch routes", () => {
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
  let projectA: string
  let projectB: string
  let notified: number

  beforeEach(async () => {
    await db.delete(sessionReviews)
    await db.delete(sessions)
    await db.delete(projects)
    await db.delete(users)
    const [user, other] = await db
      .insert(users)
      .values([
        { githubId: 1, githubLogin: "dev" },
        { githubId: 2, githubLogin: "other" },
      ])
      .returning({ id: users.id })
    userId = user?.id as string
    const otherUserId = other?.id as string
    const [a, b] = await db
      .insert(projects)
      .values([
        { name: "Project A", slug: "a", ownerUserId: userId },
        { name: "Project B", slug: "b", ownerUserId: otherUserId },
      ])
      .returning({ id: projects.id })
    projectA = a?.id as string
    projectB = b?.id as string
    await db.insert(userProjectGrant).values({ userId, projectId: projectB, scope: "viewer" })
    await db.insert(sessions).values([
      { id: "a-1", source: "claude_code", userId, projectId: projectA, title: "a one" },
      { id: "a-2", source: "claude_code", userId, projectId: projectA, title: "a two" },
      { id: "a-3", source: "claude_code", userId, projectId: projectA, title: "a three" },
      {
        id: "b-1",
        source: "claude_code",
        userId: otherUserId,
        projectId: projectB,
        title: "b one",
      },
    ])
    notified = 0
  })

  const request = async (
    path: string,
    init: {
      readonly method?: string
      readonly body?: unknown
      readonly credentialEnv?: NodeJS.ProcessEnv
    } = {},
  ): Promise<Response> => {
    const token = await signToken(env, { sub: userId, aud: "web" })
    return buildApp(db, env, {
      notifyWorker: () => {
        notified += 1
      },
      credentialEnv: init.credentialEnv ?? CREDENTIAL_ENV,
      rootLog: silentLog,
    }).request(path, {
      method: init.method ?? "GET",
      headers: {
        cookie: `session=${token}`,
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    })
  }

  const start = (sessionIds: ReadonlyArray<string>, credentialEnv?: NodeJS.ProcessEnv) =>
    request("/api/review-batches", {
      method: "POST",
      body: { sessionIds },
      ...(credentialEnv === undefined ? {} : { credentialEnv }),
    })

  const rows = () => db.select().from(sessionReviews)

  test("SC24: pressing Review on ticked sessions queues each one and wakes the worker once", async () => {
    const res = await start(["a-1", "a-2", "a-3"])

    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ queued: 3, skipped: 0, notAllowed: [] })
    const queued = await rows()
    expect(queued.map((row) => row.sessionId).sort()).toEqual(["a-1", "a-2", "a-3"])
    expect(
      queued.every((row) => row.status === "waiting" && row.analyzer === PROBLEMS_ANALYZER),
    ).toBe(true)
    // The API holds no agent runner at all; the worker runs these.
    expect(notified).toBe(1)
  })

  test("SC25: sessions that already have a review are skipped, and others' sessions are refused", async () => {
    await db.insert(sessionReviews).values({
      sessionId: "a-1",
      projectId: projectA,
      analyzer: PROBLEMS_ANALYZER,
      outcome: "productive",
      summary: "done before",
      signals: {},
    })

    const res = await start(["a-1", "a-2", "b-1", "missing"])

    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ queued: 1, skipped: 1, notAllowed: ["b-1", "missing"] })
    const byId = new Map((await rows()).map((row) => [row.sessionId, row]))
    expect(byId.get("a-1")).toMatchObject({ status: "done", summary: "done before" })
    expect(byId.get("a-2")).toMatchObject({ status: "waiting" })
    expect(byId.has("b-1")).toBe(false)
  })

  test("SC26: a session already waiting or running counts as queued and is not reset", async () => {
    await db.insert(sessionReviews).values({
      sessionId: "a-1",
      projectId: projectA,
      analyzer: PROBLEMS_ANALYZER,
      status: "running",
      attempts: 2,
    })

    const res = await start(["a-1"])

    expect(await res.json()).toEqual({ queued: 1, skipped: 0, notAllowed: [] })
    const [row] = await rows()
    expect(row).toMatchObject({ status: "running", attempts: 2 })
  })

  test("SC27: the batch status routes are gone", async () => {
    expect((await request("/api/review-batches/current")).status).toBe(404)
    expect((await request("/api/review-batches/current", { method: "DELETE" })).status).toBe(404)
  })

  test("SC14: more than 50 sessions is a 400, and so is an empty selection", async () => {
    const tooMany = await start(Array.from({ length: 51 }, (_, i) => `s-${i}`))
    expect(tooMany.status).toBe(400)
    expect(await tooMany.json()).toEqual({ error: "tooManySessions" })
    const empty = await start([])
    expect(empty.status).toBe(400)
    expect(await empty.json()).toEqual({ error: "invalidReviewBatch" })
  })

  test("a server with no reviewer key refuses and queues nothing", async () => {
    const res = await start(["a-1"], {})
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: "harnessUnauthenticated" })
    expect(await rows()).toEqual([])
    expect(notified).toBe(0)
  })

  test("only a problems review counts as a review; a session with another analyzer's is queued", async () => {
    await db.insert(sessionReviews).values({
      sessionId: "a-1",
      projectId: projectA,
      analyzer: "heuristic-v1",
      outcome: "shipped",
      summary: "static",
      signals: {},
    })

    const res = await start(["a-1"])

    expect(await res.json()).toEqual({ queued: 1, skipped: 0, notAllowed: [] })
  })
})
