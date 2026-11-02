import type { HarnessRunner } from "@samskara/core"
import pino from "pino"
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest"
import { buildApp } from "../app.js"
import type { Db } from "../db/client.js"
import { projects, sessions, userProjectGrant, users } from "../db/schema.js"
import { dockerAvailable, startTestDb } from "../db/testDb.js"
import type { Env } from "../lib/env.js"
import { signToken } from "../lib/jwt.js"
import { type AiReviewJobRegistry, createAiReviewJobRegistry } from "../services/ai-review/jobs.js"
import type { AiReviewResult } from "../services/ai-review/pipeline.js"
import {
  createReviewBatchRegistry,
  type ReviewBatchRegistry,
} from "../services/review-batch/batch.js"

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

type BatchBody = {
  readonly batch: null | {
    readonly batchId: string
    readonly status: string
    readonly sessions: ReadonlyArray<{
      readonly sessionId: string
      readonly projectId: string | null
      readonly state: string
    }>
    readonly projects: ReadonlyArray<{ readonly projectId: string; readonly name: string }>
  }
}

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
  let otherUserId: string
  let projectA: string
  let projectB: string
  /** Every review job the registry was asked to run, by session id; none ever settles. */
  let reviewCalls: string[]
  let jobs: AiReviewJobRegistry
  let reviewBatches: ReviewBatchRegistry

  beforeEach(async () => {
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
    otherUserId = other?.id as string
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
      {
        id: "b-1",
        source: "claude_code",
        userId: otherUserId,
        projectId: projectB,
        title: "b one",
      },
    ])
    reviewCalls = []
    jobs = createAiReviewJobRegistry({
      run: (_deps, _user, sessionId) => {
        reviewCalls.push(sessionId)
        return new Promise<AiReviewResult>(() => {})
      },
    })
    reviewBatches = createReviewBatchRegistry({
      jobs,
      aiReview: { db, runner: {} as HarnessRunner, env, log: silentLog },
      hasReview: async () => false,
      startLearningRun: undefined,
      log: silentLog,
      sleep: () => new Promise((resolve) => setImmediate(resolve)),
      pollMs: 1,
    })
  })

  const request = async (
    path: string,
    init: { readonly method?: string; readonly asUserId?: string; readonly body?: unknown } = {},
  ): Promise<Response> => {
    const token = await signToken(env, { sub: init.asUserId ?? userId, aud: "web" })
    return buildApp(db, env, {
      aiReviewRunner: {} as HarnessRunner,
      aiReviewJobs: jobs,
      reviewBatches,
      credentialEnv: CREDENTIAL_ENV,
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

  const start = (sessionIds: ReadonlyArray<string>, asUserId?: string) =>
    request("/api/review-batches", {
      method: "POST",
      body: { sessionIds },
      ...(asUserId === undefined ? {} : { asUserId }),
    })

  const current = async (asUserId?: string): Promise<BatchBody> => {
    const res = await request(
      "/api/review-batches/current",
      asUserId === undefined ? {} : { asUserId },
    )
    expect(res.status).toBe(200)
    return (await res.json()) as BatchBody
  }

  const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

  test("SC12: starting a batch answers 202 and the current-batch endpoint reports it", async () => {
    const res = await start(["a-1", "a-2"])
    expect(res.status).toBe(202)
    const body = (await res.json()) as { batchId: string; notAllowed: string[] }
    expect(body.batchId).toEqual(expect.any(String))
    expect(body.notAllowed).toEqual([])

    const { batch } = await current()
    expect(batch?.batchId).toBe(body.batchId)
    expect(batch?.status).toBe("running")
    expect(batch?.sessions.map((session) => session.sessionId).sort()).toEqual(["a-1", "a-2"])
    expect(batch?.projects).toEqual([
      { projectId: projectA, name: "Project A", state: "waiting", reason: null },
    ])
  })

  test("SC13: a session the user may not edit, or cannot see, is listed as not allowed and not reviewed", async () => {
    const res = await start(["a-1", "b-1", "no-such-session"])
    expect(res.status).toBe(202)
    const body = (await res.json()) as { notAllowed: string[] }
    expect([...body.notAllowed].sort()).toEqual(["b-1", "no-such-session"])

    const { batch } = await current()
    const refused = batch?.sessions.filter((session) => session.state === "notAllowed")
    expect(refused?.map((session) => [session.sessionId, session.projectId]).sort()).toEqual([
      ["b-1", null],
      ["no-such-session", null],
    ])
    for (let i = 0; i < 20; i += 1) await tick()
    expect(reviewCalls).toEqual(["a-1"])
  })

  test("SC14: more than 50 sessions is a 400", async () => {
    const ids = Array.from({ length: 51 }, (_, index) => `session-${index}`)
    const res = await start(ids)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: "tooManySessions" })
    expect((await current()).batch).toBeNull()
  })

  test("SC15: a second start while one runs is a 409", async () => {
    const first = (await (await start(["a-1"])).json()) as { batchId: string }
    const second = await start(["a-2"])
    expect(second.status).toBe(409)
    expect(await second.json()).toEqual({ error: "reviewBatchAlreadyRunning" })
    expect((await current()).batch?.batchId).toBe(first.batchId)
  })

  test("SC16: a user with no batch gets null, and never sees another user's", async () => {
    expect((await start(["a-1"])).status).toBe(202)
    expect(await current(otherUserId)).toEqual({ batch: null })
  })

  test("an empty selection is a 400", async () => {
    const res = await start([])
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: "invalidReviewBatch" })
  })
})
