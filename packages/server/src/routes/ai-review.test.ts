import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { createLogger, type HarnessRunner, type NormalizedMessage } from "@samskara/core"
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest"
import { buildApp } from "../app.js"
import type { Db } from "../db/client.js"
import {
  messages,
  projects,
  reviewProblems,
  sessionReviews,
  sessions,
  userProjectGrant,
  users,
} from "../db/schema.js"
import { dockerAvailable, startTestDb } from "../db/testDb.js"
import type { Env } from "../lib/env.js"
import { signToken } from "../lib/jwt.js"
import { reviewSessions } from "../repositories/learnings.repo.js"
import { runAiReview } from "../services/ai-review/pipeline.js"
import { createWorkLoop, reviewOptions } from "../worker/loop.js"

/** The reviewer credential every lane now reads from the environment. */
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

const sessionId = "ai-review-route-session"

const fixtures: ReadonlyArray<NormalizedMessage> = [
  {
    subIndex: 0,
    sessionId,
    source: "claude_code",
    sourceSchemaVersion: 1,
    trackId: "main",
    msgType: "message",
    role: "user",
    content: { type: "text", value: "fix the build" },
  },
  {
    subIndex: 1,
    sessionId,
    source: "claude_code",
    sourceSchemaVersion: 1,
    trackId: "main",
    msgType: "message",
    role: "assistant",
    content: { type: "text", value: "done" },
  },
]

/** A problems review of the fixture session: one problem, quoting the agent's "done". */
const okReviewMd = `# Review

- **Outcome:** productive

## Summary

Clean two-message session.

## Problems

### Said done without showing the build passing

- **Class:** missed
- **Severity:** medium — the build may still be broken
- **Fix type:** skill
- **Description:** The agent was expected to show the build passing. It only said done.
- **Evidence:** msg-1 — "done" — this is the whole reply; no build ran.
- **Learning:** Run the build and show its result before saying done.
`

/** Writes the review every time; the readers' one-shot calls ignore the file. */
const fakeRunner: HarnessRunner = {
  run: async ({ workspaceDir }) => {
    await writeFile(join(workspaceDir, "review.md"), okReviewMd)
    return { stdout: "review.md ready", firstByteMs: 250 }
  },
}

describe.skipIf(!dockerAvailable())("ai review routes", () => {
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
  let notified: number

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
      title: "route session",
    })
    for (const message of fixtures) {
      await db.insert(messages).values({
        sessionId,
        lineUuid: crypto.randomUUID(),
        subIndex: message.subIndex,
        msgType: message.msgType,
        role: message.msgType === "message" ? message.role : null,
        lineNumber: message.subIndex + 1,
        source: "claude_code",
        sourceRelativePath: "test.jsonl",
        trackId: message.trackId,
        raw: {},
        sourceSchemaVersion: 1,
        content: message.msgType === "message" ? message.content : null,
        details: {},
      })
    }
    notified = 0
  })

  const app = (credentialEnv: NodeJS.ProcessEnv = CREDENTIAL_ENV) =>
    buildApp(db, env, {
      credentialEnv,
      notifyWorker: () => {
        notified += 1
      },
    })

  const request = async (
    path: string,
    init: { readonly method?: string; readonly asUserId?: string; readonly body?: unknown } = {},
  ): Promise<Response> => {
    const token = await signToken(env, { sub: init.asUserId ?? userId, aud: "web" })
    return app().request(path, {
      method: init.method ?? "GET",
      headers: {
        cookie: `session=${token}`,
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    })
  }

  /** Runs what is queued the way the worker does, with a fake agent, until nothing is left. */
  const drainQueue = async (runner: HarnessRunner = fakeRunner): Promise<void> => {
    const log = createLogger({ service: "ai-review-test", level: "silent" })
    const loop = createWorkLoop({
      db,
      log,
      runReview: (review) =>
        runAiReview(
          { db, runner, env, log, credentialEnv: CREDENTIAL_ENV },
          review,
          reviewOptions(review),
        ),
    })
    await loop.tick()
    await loop.idle()
  }

  const reviewRow = async () => {
    const [row] = await db
      .select()
      .from(sessionReviews)
      .where(eq(sessionReviews.analyzer, "ai-problems-v2"))
    return row
  }

  const analyze = async (body?: unknown): Promise<string> => {
    const res = await request(`/api/sessions/${sessionId}/analyze`, {
      method: "POST",
      ...(body === undefined ? {} : { body }),
    })
    expect(res.status).toBe(202)
    return ((await res.json()) as { jobId: string }).jobId
  }

  const jobStatus = async (jobId: string, asUserId?: string) =>
    request(
      `/api/sessions/${sessionId}/analyze/${jobId}`,
      asUserId === undefined ? {} : { asUserId },
    )

  const doneReview = {
    sessionId: "",
    analyzer: "ai-problems-v2",
    outcome: "productive",
    summary: "the old verdict",
    signals: {},
  } as const

  test("SC15: analyze queues the review and wakes the worker", async () => {
    const res = await buildApp(db, env, {
      credentialEnv: CREDENTIAL_ENV,
      notifyWorker: () => {
        notified += 1
      },
    }).request(`/api/sessions/${sessionId}/analyze`, {
      method: "POST",
      headers: {
        cookie: `session=${await signToken(env, { sub: userId, aud: "web" })}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ harness: "claude", model: "opus", prompt: "look for loops" }),
    })

    expect(res.status).toBe(202)
    const { jobId } = (await res.json()) as { jobId: string }
    expect(await reviewRow()).toMatchObject({
      id: jobId,
      status: "waiting",
      harness: "claude",
      model: "opus",
      prompt: "look for loops",
    })
    // The API holds no agent runner at all, so nothing ran: the row is still waiting.
    expect(notified).toBe(1)
  })

  test("SC15: the worker runs a queued review with the harness and model saved on it", async () => {
    const jobId = await analyze({ harness: "claude", model: "opus" })
    const seen: Array<{ harness?: string; model?: string }> = []
    await drainQueue({
      run: async (input) => {
        seen.push({ harness: input.harness, model: input.model })
        return fakeRunner.run(input)
      },
    })

    expect(seen).toContainEqual({ harness: "claude", model: "opus" })
    const ai = await request(`/api/sessions/${sessionId}/aireview`)
    const aiBody = (await ai.json()) as {
      review: { id: string; signals: { model?: string; harness?: string } }
      job?: unknown
    }
    expect(aiBody.review.id).toBe(jobId)
    expect(aiBody.review.signals).toMatchObject({ model: "opus", harness: "claude" })
    expect(aiBody.job).toBeUndefined()
  })

  test("SC15: a queued review lands with its problems once the worker runs it", async () => {
    const jobId = await analyze()
    await drainQueue()

    const job = await jobStatus(jobId)
    expect(await job.json()).toEqual({
      job: { status: "succeeded", jobId, reviewId: jobId },
    })
    const ai = await request(`/api/sessions/${sessionId}/aireview`)
    expect(ai.status).toBe(200)
    const body = (await ai.json()) as { review: Record<string, unknown>; job?: unknown }
    expect(body.job).toBeUndefined()
    expect(body.review).toMatchObject({
      id: jobId,
      outcome: "productive",
      summary: "Clean two-message session.",
      problems: [
        {
          title: "Said done without showing the build passing",
          class: "missed",
          severity: "medium",
          fixType: "skill",
          evidence: [{ from: "msg-1", to: "msg-1", quote: "done" }],
        },
      ],
    })
  })

  test("SC16: analyze refuses a second review while one is queued", async () => {
    await analyze()
    notified = 0

    const second = await request(`/api/sessions/${sessionId}/analyze`, {
      method: "POST",
      body: { mode: "full" },
    })

    expect(second.status).toBe(409)
    expect(await second.json()).toEqual({ error: "analysisAlreadyRunning" })
    expect(notified).toBe(0)
  })

  test("SC16: two analyze requests at once queue exactly one review", async () => {
    const [first, second] = await Promise.all([
      request(`/api/sessions/${sessionId}/analyze`, { method: "POST" }),
      request(`/api/sessions/${sessionId}/analyze`, { method: "POST" }),
    ])
    expect([first.status, second.status].sort()).toEqual([202, 409])
    expect(await db.select().from(sessionReviews)).toHaveLength(1)
    expect(notified).toBe(1)
  })

  test("SC17: analyze still refuses a viewer", async () => {
    const [viewer] = await db
      .insert(users)
      .values({ githubId: 2, githubLogin: "viewer" })
      .returning({ id: users.id })
    await db.insert(userProjectGrant).values({
      userId: viewer?.id as string,
      projectId,
      scope: "viewer",
    })
    const res = await request(`/api/sessions/${sessionId}/analyze`, {
      method: "POST",
      asUserId: viewer?.id as string,
    })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: "notEditable" })
    expect(await db.select().from(sessionReviews)).toHaveLength(0)
    expect(notified).toBe(0)
  })

  test("SC18: job status follows the row", async () => {
    const jobId = await analyze()
    const running = { job: { status: "running", jobId, sessionId, lastEvent: null } }

    expect(await (await jobStatus(jobId)).json()).toMatchObject(running)

    await db.update(sessionReviews).set({ status: "running", attempts: 1 })
    expect(await (await jobStatus(jobId)).json()).toMatchObject(running)

    await db
      .update(sessionReviews)
      .set({ status: "failed", attempts: 3, error: "harnessFailed: boom" })
    expect(await (await jobStatus(jobId)).json()).toEqual({
      job: { status: "failed", jobId, code: "harnessFailed", detail: { message: "boom" } },
    })

    // A new press after the failure is a new run; the failed one stays failed.
    const again = await analyze({ mode: "full" })
    expect(again).not.toBe(jobId)
    await drainQueue()
    expect(await (await jobStatus(again)).json()).toEqual({
      job: { status: "succeeded", jobId: again, reviewId: again },
    })
    expect(await (await jobStatus(jobId)).json()).toMatchObject({ job: { status: "failed" } })
  })

  test("SC18: a failed reason the web does not know reads as harnessFailed", async () => {
    const jobId = await analyze()
    await db.update(sessionReviews).set({ status: "failed", error: "something odd" })
    expect(await (await jobStatus(jobId)).json()).toEqual({
      job: {
        status: "failed",
        jobId,
        code: "harnessFailed",
        detail: { message: "something odd" },
      },
    })
  })

  test("SC19: a reloaded session page sees the review in progress beside the old one", async () => {
    await db.insert(sessionReviews).values({ ...doneReview, sessionId, projectId })
    await analyze({ mode: "full" })

    const res = await request(`/api/sessions/${sessionId}/aireview`)

    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      review: { summary: string; problems: unknown[] }
      job: { status: string; lastEvent: unknown }
    }
    expect(body.review).toMatchObject({ summary: "the old verdict", problems: [] })
    expect(body.job).toMatchObject({ status: "running", lastEvent: null })
  })

  test("SC19: a first review in progress shows no result yet, only the job", async () => {
    const jobId = await analyze()
    const res = await request(`/api/sessions/${sessionId}/aireview`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      review: null,
      runs: [],
      newMessages: false,
      job: { jobId, status: "running", startedAt: expect.any(String), lastEvent: null },
    })
  })

  test("SC20: a job id from another session is not found", async () => {
    const other = "ai-review-other-session"
    await db.insert(sessions).values({
      id: other,
      source: "claude_code",
      userId,
      projectId,
      title: "other",
    })
    const jobId = await analyze()

    const res = await request(`/api/sessions/${other}/analyze/${jobId}`)

    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: "jobNotFound" })
    const notAnId = await request(`/api/sessions/${sessionId}/analyze/not-a-uuid`)
    expect(notAnId.status).toBe(404)
  })

  test("A3: analyzing a missing or invisible session returns 404 sessionNotFound", async () => {
    const res = await request("/api/sessions/does-not-exist/analyze", { method: "POST" })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: "sessionNotFound" })
  })

  test("A4: GET /:id/aireview returns 404 noAiReview when only the static review exists", async () => {
    await db.insert(sessionReviews).values({
      sessionId,
      projectId,
      analyzer: "heuristic-v1",
      outcome: "shipped",
      summary: "static",
      signals: {},
    })
    const res = await request(`/api/sessions/${sessionId}/aireview`)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: "noAiReview" })
  })

  test("A5: analyze requires auth", async () => {
    const res = await app().request(`/api/sessions/${sessionId}/analyze`, { method: "POST" })
    expect(res.status).toBe(401)
  })

  test("A7: analyze on a session that already holds a review queues a new run beside it", async () => {
    const [old] = await db
      .insert(sessionReviews)
      .values({ ...doneReview, sessionId, projectId })
      .returning()
    const jobId = await analyze()
    expect(jobId).not.toBe(old?.id)
    expect(await db.select().from(sessionReviews)).toHaveLength(2)
  })

  test("A10: an unrecognized harness or a blank model in the body is 400, not a silent env fallback", async () => {
    const badHarness = await request(`/api/sessions/${sessionId}/analyze`, {
      method: "POST",
      body: { harness: "cursor" },
    })
    expect(badHarness.status).toBe(400)
    expect(await badHarness.json()).toEqual({ error: "invalidHarness" })

    const badModel = await request(`/api/sessions/${sessionId}/analyze`, {
      method: "POST",
      body: { harness: "claude", model: "  " },
    })
    expect(badModel.status).toBe(400)
    expect(await badModel.json()).toEqual({ error: "invalidModel" })
  })

  test("A12: mode full adds a new run once the worker runs it, and the old one stays done", async () => {
    await db.insert(sessionReviews).values({ ...doneReview, sessionId, projectId })
    await analyze({ mode: "full" })
    await drainQueue()

    const rows = (await db.select().from(sessionReviews)).filter(
      (row) => row.sessionId === sessionId,
    )
    expect(rows.map((row) => [row.status, row.summary]).sort()).toEqual([
      ["done", "Clean two-message session."],
      ["done", "the old verdict"],
    ])
  })

  test("A14: analyze refuses an unauthenticated harness synchronously, queueing nothing", async () => {
    const token = await signToken(env, { sub: userId, aud: "web" })
    const res = await app({ OPENCODE_API_KEY: "oc-key" }).request(
      `/api/sessions/${sessionId}/analyze`,
      {
        method: "POST",
        headers: { cookie: `session=${token}`, "content-type": "application/json" },
        body: JSON.stringify({ harness: "claude" }),
      },
    )
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: "harnessUnauthenticated" })
    expect(await db.select().from(sessionReviews)).toHaveLength(0)
    expect(notified).toBe(0)
  })

  test("A15: with AI_REVIEW_HARDEN=0 the probe asks for opencode itself, not msb", async () => {
    const token = await signToken(env, { sub: userId, aud: "web" })
    const asked: string[] = []
    const res = await buildApp(db, env, {
      commandExists: (cmd) => {
        asked.push(cmd)
        return true
      },
      credentialEnv: { ...CREDENTIAL_ENV, AI_REVIEW_HARDEN: "0" },
    }).request("/api/reviewer-options", { headers: { cookie: `session=${token}` } })
    expect(res.status).toBe(200)
    expect(asked).toContain("opencode")
    expect(asked).not.toContain("msb")
  })

  test("A13: an installed harness with no credential is not offered as available", async () => {
    const token = await signToken(env, { sub: userId, aud: "web" })
    const res = await buildApp(db, env, {
      commandExists: () => true,
      credentialEnv: { OPENCODE_API_KEY: "oc-key" },
    }).request("/api/reviewer-options", { headers: { cookie: `session=${token}` } })
    const body = (await res.json()) as {
      harnesses: ReadonlyArray<{ harness: string; available: boolean }>
    }
    expect(body.harnesses).toMatchObject([
      { harness: "opencode", available: true },
      { harness: "claude", available: false },
    ])
  })

  test("A11: GET /api/sessions/reviewer-options lists each harness with its default model and availability", async () => {
    const token = await signToken(env, { sub: userId, aud: "web" })
    const res = await buildApp(db, env, {
      // In the hardened lane the host binary is msb; opencode is installed inside the VM.
      commandExists: (cmd) => cmd === "msb",
      credentialEnv: CREDENTIAL_ENV,
    }).request("/api/reviewer-options", { headers: { cookie: `session=${token}` } })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      defaultHarness: string
      defaultModel: string
      harnesses: ReadonlyArray<{
        harness: string
        defaultModel: string
        available: boolean
        models: ReadonlyArray<string>
      }>
    }
    expect(body.defaultHarness).toBe("opencode")
    expect(body.defaultModel).toBe("fake-model")
    expect(body.harnesses).toEqual([
      {
        harness: "opencode",
        defaultModel: "opencode-go/glm-5.3-flash",
        available: true,
        models: ["opencode-go/glm-5.3-flash", "fake-model"],
      },
      {
        harness: "claude",
        defaultModel: "sonnet",
        available: false,
        models: ["sonnet", "opus", "haiku"],
      },
    ])
  })

  test("A17: a stranger cannot see a queued review through /aireview or poll it by jobId", async () => {
    const jobId = await analyze()
    await db.update(sessionReviews).set({ status: "failed", error: "harnessFailed: /tmp/ws" })
    await analyze({ mode: "full" })

    const [stranger] = await db
      .insert(users)
      .values({ githubId: 991, githubLogin: "stranger" })
      .returning({ id: users.id })
    const asStranger = { asUserId: stranger?.id as string }

    const peek = await request(`/api/sessions/${sessionId}/aireview`, asStranger)
    expect(peek.status).toBe(404)
    await expect(peek.json()).resolves.toEqual({ error: "noAiReview" })

    const poll = await jobStatus(jobId, asStranger.asUserId)
    expect(poll.status).toBe(404)
    await expect(poll.json()).resolves.toEqual({ error: "jobNotFound" })

    // The owner still sees both.
    expect((await request(`/api/sessions/${sessionId}/aireview`)).status).toBe(200)
    expect((await jobStatus(jobId)).status).toBe(200)
  })

  test("A21: the old force flag is refused as an unknown field", async () => {
    const forced = await request(`/api/sessions/${sessionId}/analyze`, {
      method: "POST",
      body: { force: true },
    })
    expect(forced.status).toBe(400)
    expect(await forced.json()).toEqual({ error: "invalidAnalyzeBody" })
  })

  test("A22: an unknown field or an empty prompt is 400", async () => {
    // The reviewer choice is gone with the old reviewer; a client still sending it is told.
    const oldReviewer = await request(`/api/sessions/${sessionId}/analyze`, {
      method: "POST",
      body: { reviewer: "lenses" },
    })
    expect(oldReviewer.status).toBe(400)
    expect(await oldReviewer.json()).toEqual({ error: "invalidAnalyzeBody" })
    const badPrompt = await request(`/api/sessions/${sessionId}/analyze`, {
      method: "POST",
      body: { prompt: "   " },
    })
    expect(await badPrompt.json()).toEqual({ error: "invalidPrompt" })
  })

  test("A23: aireview is 404 for a user who cannot see the session, and when nothing ran", async () => {
    const [stranger] = await db
      .insert(users)
      .values({ githubId: 77, githubLogin: "stranger" })
      .returning({ id: users.id })
    const hidden = await request(`/api/sessions/${sessionId}/aireview`, {
      asUserId: stranger?.id as string,
    })
    expect(hidden.status).toBe(404)
    const none = await request(`/api/sessions/${sessionId}/aireview`)
    expect(none.status).toBe(404)
    expect(await none.json()).toEqual({ error: "noAiReview" })
  })

  test("A25: a first review that failed all its tries shows no result and the failed job with its reason", async () => {
    const jobId = await analyze()
    await db.update(sessionReviews).set({ status: "failed", error: "harnessFailed: boom" })
    const res = await request(`/api/sessions/${sessionId}/aireview`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      review: null,
      runs: [],
      newMessages: false,
      job: { jobId, status: "failed", code: "harnessFailed", detail: { message: "boom" } },
    })
  })

  test("a redo that failed all its tries keeps the old result beside the failed job", async () => {
    await db.insert(sessionReviews).values({ ...doneReview, sessionId, projectId })
    const jobId = await analyze({ mode: "full" })
    await db
      .update(sessionReviews)
      .set({ status: "failed", error: "unparseable: bad file" })
      .where(eq(sessionReviews.id, jobId))
    const body = (await (await request(`/api/sessions/${sessionId}/aireview`)).json()) as {
      review: { summary: string }
      job: unknown
    }
    expect(body.review).toMatchObject({ summary: "the old verdict" })
    expect(body.job).toEqual({
      jobId,
      status: "failed",
      code: "unparseable",
      detail: { message: "bad file" },
    })
  })
  test("SC6: after a newer full run the page shows only it, and the older run's problem still resolves its evidence through its own recordIds", async () => {
    const [cited] = await db
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.lineNumber, 2))
    await analyze()
    await drainQueue()
    const older = await reviewRow()
    await analyze({ mode: "full" })
    await drainQueue()

    const body = (await (await request(`/api/sessions/${sessionId}/aireview`)).json()) as {
      review: { id: string }
      runs: Array<{ id: string; kind: string; summary: string; problems: unknown[] }>
    }
    expect(body.runs).toHaveLength(1)
    expect(body.runs[0]?.id).not.toBe(older?.id)
    expect(body.runs[0]).toMatchObject({ kind: "full", summary: "Clean two-message session." })
    expect(body.runs[0]?.problems).toHaveLength(1)
    expect(body.review.id).toBe(body.runs[0]?.id)

    // The kept problem cites msg-1, the agent's "done": the second message seeded.
    const [kept] = await reviewSessions(db, [older?.id as string])
    expect(kept?.recordIds?.[1]).toBe(cited?.id)
    const keptProblems = await db
      .select()
      .from(reviewProblems)
      .where(eq(reviewProblems.reviewId, older?.id as string))
    expect(keptProblems).toHaveLength(1)
  })

  test("SC9: the rule-based review endpoint is gone", async () => {
    const res = await request(`/api/sessions/${sessionId}/review`, { method: "POST" })
    expect(res.status).toBe(404)
  })
  test("SC18: newMessages is refused with 400 nothingNew for a never-reviewed session and for one with nothing after its done run; a later message lets it queue on that run", async () => {
    const refuse = async () => {
      const res = await request(`/api/sessions/${sessionId}/analyze`, {
        method: "POST",
        body: { mode: "newMessages" },
      })
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: "nothingNew" })
    }
    await refuse()
    expect(await db.select().from(sessionReviews)).toHaveLength(0)

    const [last] = await db
      .update(messages)
      .set({ timestamp: new Date("2026-01-01T10:00:00Z") })
      .returning({ id: messages.id, lineNumber: messages.lineNumber })
    const [base] = await db
      .insert(sessionReviews)
      .values({ ...doneReview, sessionId, projectId, status: "done", lastMessageId: last?.id })
      .returning()
    await refuse()
    expect(await db.select().from(sessionReviews)).toHaveLength(1)

    await db.insert(messages).values({
      sessionId,
      lineUuid: crypto.randomUUID(),
      subIndex: 0,
      msgType: "message",
      role: "user",
      lineNumber: 9,
      raw: {},
      sourceSchemaVersion: 1,
      content: { type: "text", value: "one more thing" },
      timestamp: new Date("2026-01-01T11:00:00Z"),
    })
    const jobId = await analyze({ mode: "newMessages" })
    const [row] = await db.select().from(sessionReviews).where(eq(sessionReviews.id, jobId))
    expect(row).toMatchObject({ status: "waiting", newPartOnly: true, basedOn: base?.id })
  })
  test("SC24: GET aireview says newMessages false right after a done run and true once a later message arrives, with runs newest first", async () => {
    await db.update(messages).set({ timestamp: new Date("2026-01-01T10:00:00Z") })
    await analyze()
    await drainQueue()

    const before = (await (await request(`/api/sessions/${sessionId}/aireview`)).json()) as {
      newMessages: boolean
      runs: Array<{ id: string; problems: unknown[] }>
    }
    expect(before.newMessages).toBe(false)
    expect(before.runs).toHaveLength(1)
    expect(before.runs[0]?.problems).toHaveLength(1)

    await db.insert(messages).values({
      sessionId,
      lineUuid: crypto.randomUUID(),
      subIndex: 0,
      msgType: "message",
      role: "user",
      lineNumber: 9,
      raw: {},
      sourceSchemaVersion: 1,
      content: { type: "text", value: "one more thing" },
      timestamp: new Date("2026-01-01T11:00:00Z"),
    })
    const after = (await (await request(`/api/sessions/${sessionId}/aireview`)).json()) as {
      newMessages: boolean
    }
    expect(after.newMessages).toBe(true)
  })
})
