import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { NormalizedMessage } from "@samskara/core"
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql"
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
import type { Env } from "../lib/env.js"
import { signToken } from "../lib/jwt.js"
import {
  dockerAvailable,
  localServerUrl,
  type TestDbHandle,
  throwawayOnLocalServer,
} from "../lib/test-db.js"
import { createAiReviewJobRegistry } from "../services/ai-review/jobs.js"
import type { AiReviewResult } from "../services/ai-review/pipeline.js"
import type { HarnessRunner } from "../services/ai-review/runner.js"

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

const okPayload = {
  analyzer: "ai-v1",
  model: "fake-model",
  harness: "test-harness",
  outcome: "productive",
  friction: "none",
  summary: "Clean two-message session.",
  lenses: [
    {
      lens: "timeline",
      entries: [
        {
          id: "all",
          kind: "phase",
          title: "The whole session",
          summary: "Prompt, answer.",
          fromSeq: 0,
          toSeq: 1,
          messageIds: ["msg-0", "msg-1"],
          tracks: ["main"],
        },
      ],
    },
    { lens: "humanLearnings", learnings: [] },
    { lens: "agentLearnings", learnings: [] },
  ],
}

const okXml = [
  `<review outcome="${okPayload.outcome}" friction="${okPayload.friction}" model="?" harness="?">`,
  `  <summary>${okPayload.summary}</summary>`,
  "  <timeline>",
  '    <entry id="all" kind="phase" from-seq="0" to-seq="1" tracks="main">',
  "      <title>The whole session</title>",
  "      <summary>Prompt, answer.</summary>",
  "      <message-ids>",
  "        <id>msg-0</id>",
  "        <id>msg-1</id>",
  "      </message-ids>",
  "    </entry>",
  "  </timeline>",
  "  <humanLearnings></humanLearnings>",
  "  <agentLearnings></agentLearnings>",
  "  <harnessLearnings></harnessLearnings>",
  '  <counts timeline="1" human="0" agent="0" breadcrumbs="0"/>',
  "</review>",
].join("\n")

/** The v2 contract: the deliverable is the review.xml FILE, and the reply is one line. */
const fakeRunner: HarnessRunner = {
  run: async ({ workspaceDir }) => {
    await writeFile(join(workspaceDir, "review.xml"), okXml)
    return {
      stdout: "review.xml ready: 1 timeline entry",
      exitCode: 0,
      firstByteMs: 250,
    }
  },
}

describe.skipIf(localServerUrl() === undefined && !dockerAvailable())("ai review routes", () => {
  let container: StartedPostgreSqlContainer | undefined
  let handle: TestDbHandle | undefined
  let db: Db

  beforeAll(async () => {
    const local = localServerUrl()
    if (local !== undefined) {
      handle = await throwawayOnLocalServer(local)
      db = handle.db
      return
    }
    container = await new PostgreSqlContainer("pgvector/pgvector:pg16").start()
    const url = container.getConnectionUri()
    handle = await throwawayOnLocalServer(url)
    db = handle.db
  }, 120_000)

  afterAll(async () => {
    await handle?.stop()
    await container?.stop().catch(() => undefined)
  })

  let userId: string
  let projectId: string
  let registry: ReturnType<typeof createAiReviewJobRegistry>

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
    registry = createAiReviewJobRegistry()
  })

  const request = async (
    path: string,
    init: { readonly method?: string; readonly asUserId?: string; readonly body?: unknown } = {},
  ): Promise<Response> => {
    const token = await signToken(env, { sub: init.asUserId ?? userId, aud: "web" })
    return buildApp(db, env, { aiReviewRunner: fakeRunner, aiReviewJobs: registry }).request(path, {
      method: init.method ?? "GET",
      headers: {
        cookie: `session=${token}`,
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    })
  }

  const waitForJob = async (jobId: string) => {
    for (let i = 0; i < 200; i += 1) {
      const job = registry.getAiReviewJob(jobId)
      if (job !== undefined && job.status !== "running") return job
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    throw new Error("job never left running")
  }

  test("A1: POST /:id/analyze returns 202 with a jobId that lands the ai-v1 review", async () => {
    const res = await request(`/api/sessions/${sessionId}/analyze`, { method: "POST" })
    expect(res.status).toBe(202)
    const body = (await res.json()) as { jobId: string }
    expect(typeof body.jobId).toBe("string")

    const job = await waitForJob(body.jobId)
    expect(job).toMatchObject({ status: "succeeded" })

    const ai = await request(`/api/sessions/${sessionId}/aireview`)
    expect(ai.status).toBe(200)
    const aiBody = (await ai.json()) as {
      review: {
        id: string
        createdAt: string
        outcome: string
        friction: string
        summary: string
        signals: {
          model: string
          harness: string
          lenses: ReadonlyArray<{ lens: string }>
          numbers: {
            durationMs: number | null
            recordCount: number
            toolCallCount: number
            inputTokens: number
            outputTokens: number
            cachedTokens: number
            thinkingTokens: number
          }
          run: {
            startedAt: string
            finishedAt: string
            milestones: ReadonlyArray<{ name: string }>
            recovered: ReadonlyArray<string>
            selfCounts: { timeline: number; human: number; agent: number; breadcrumbs: number }
            xmlBytes: number
            agentLog: string
          }
        }
      }
    }
    expect(aiBody.review.id).toBe(job.status === "succeeded" ? job.reviewId : undefined)
    expect(aiBody.review.outcome).toBe("productive")
    expect(aiBody.review.summary).toBe("Clean two-message session.")
    expect(aiBody.review.signals.model).toBe("fake-model")
    // The pipeline stamps the runner's identity over whatever the model claimed.
    expect(aiBody.review.signals.harness).toBe("opencode")
    // All four lenses, the synthesized empty harness one included.
    expect(aiBody.review.signals.lenses).toHaveLength(4)
    // Server-computed numbers (never model-claimed) and the run log ride along in signals.
    expect(aiBody.review.signals.numbers).toEqual({
      durationMs: null,
      recordCount: 2,
      toolCallCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      thinkingTokens: 0,
    })
    const milestoneNames = aiBody.review.signals.run.milestones.map((m) => m.name)
    expect(milestoneNames).toContain("template_staged")
    expect(milestoneNames).toContain("deliverable_read")
    expect(aiBody.review.signals.run.selfCounts).toEqual({
      timeline: 1,
      human: 0,
      agent: 0,
      breadcrumbs: 0,
    })
    expect(aiBody.review.signals.run.xmlBytes).toBe(Buffer.byteLength(okXml))
    expect(aiBody.review.signals.run.agentLog).toContain("review.xml ready")
  })

  test("A2: a viewer without edit rights gets 403 notEditable", async () => {
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
  })

  test("A3: analyzing a missing or invisible session returns 404 sessionNotFound", async () => {
    const res = await request("/api/sessions/does-not-exist/analyze", { method: "POST" })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: "sessionNotFound" })
  })

  test("A4: GET /:id/aireview returns 404 noAiReview when no ai-v1 review exists", async () => {
    await db.insert(sessionReviews).values({
      sessionId,
      projectId,
      analyzer: "heuristic-v1",
      outcome: "shipped",
      friction: "none",
      summary: "static",
      signals: {},
    })
    const res = await request(`/api/sessions/${sessionId}/aireview`)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: "noAiReview" })
  })

  test("A5: analyze requires auth", async () => {
    const res = await buildApp(db, env, {
      aiReviewRunner: fakeRunner,
      aiReviewJobs: registry,
    }).request(`/api/sessions/${sessionId}/analyze`, { method: "POST" })
    expect(res.status).toBe(401)
  })

  test("A6: a second analyze while the session's job is running returns 409 analysisAlreadyRunning", async () => {
    // A run that never settles, so the first job stays non-terminal through the test.
    registry = createAiReviewJobRegistry({
      run: () => new Promise<AiReviewResult>(() => {}),
    })
    const first = await request(`/api/sessions/${sessionId}/analyze`, { method: "POST" })
    expect(first.status).toBe(202)

    const second = await request(`/api/sessions/${sessionId}/analyze`, { method: "POST" })
    expect(second.status).toBe(409)
    expect(await second.json()).toEqual({ error: "analysisAlreadyRunning" })
  })

  test("A7: analyze on a session that already holds an ai-v1 review returns 409 analysisAlreadyExists", async () => {
    await db.insert(sessionReviews).values({
      sessionId,
      projectId,
      analyzer: "ai-v1",
      outcome: "productive",
      friction: "none",
      summary: "already reviewed",
      signals: {},
    })
    const res = await request(`/api/sessions/${sessionId}/analyze`, { method: "POST" })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: "analysisAlreadyExists" })
  })

  test("A8: GET /:id/aireview carries the running job, and omits the field when none is running", async () => {
    registry = createAiReviewJobRegistry({
      run: () => new Promise<AiReviewResult>(() => {}),
      now: () => new Date("2026-08-26T20:00:00Z"),
    })
    await request(`/api/sessions/${sessionId}/analyze`, { method: "POST" })

    const res = await request(`/api/sessions/${sessionId}/aireview`)
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({
      review: null,
      job: {
        jobId: expect.any(String),
        status: "running",
        startedAt: "2026-08-26T20:00:00.000Z",
        lastEvent: null,
      },
    })

    // With a settled registry and a landed review, the job field is gone — the shape
    // the web's backward-compat path relies on.
    await db.insert(sessionReviews).values({
      sessionId,
      projectId,
      analyzer: "ai-v1",
      outcome: "productive",
      friction: "none",
      summary: "already reviewed",
      signals: {},
    })
    registry = createAiReviewJobRegistry()
    const settled = await request(`/api/sessions/${sessionId}/aireview`)
    expect(settled.status).toBe(200)
    const body = (await settled.json()) as { review: unknown; job?: unknown }
    expect(body.job).toBeUndefined()
    expect(body.review).toMatchObject({ outcome: "productive" })
  })

  test("A9: analyze accepts a per-run harness and model in the body, and the run uses them", async () => {
    const seen: Array<{ harness?: string; model?: string }> = []
    const capturing: HarnessRunner = {
      run: async (input) => {
        seen.push({ harness: input.harness, model: input.model })
        return fakeRunner.run(input)
      },
    }
    registry = createAiReviewJobRegistry()
    const token = await signToken(env, { sub: userId, aud: "web" })
    const res = await buildApp(db, env, {
      aiReviewRunner: capturing,
      aiReviewJobs: registry,
    }).request(`/api/sessions/${sessionId}/analyze`, {
      method: "POST",
      headers: { cookie: `session=${token}`, "content-type": "application/json" },
      body: JSON.stringify({ harness: "claude", model: "opus" }),
    })
    expect(res.status).toBe(202)
    const body = (await res.json()) as { jobId: string }
    await waitForJob(body.jobId)

    expect(seen).toContainEqual({ harness: "claude", model: "opus" })
    const ai = await request(`/api/sessions/${sessionId}/aireview`)
    const aiBody = (await ai.json()) as {
      review: { signals: { model?: string; harness?: string } }
    }
    expect(aiBody.review.signals).toMatchObject({ model: "opus", harness: "claude" })
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

  test("A12: force=true on a session that already holds an ai-v1 review redoes it instead of 409", async () => {
    await db.insert(sessionReviews).values({
      sessionId,
      projectId,
      analyzer: "ai-v1",
      outcome: "productive",
      friction: "none",
      summary: "the old verdict",
      signals: {},
    })
    const res = await request(`/api/sessions/${sessionId}/analyze`, {
      method: "POST",
      body: { force: true },
    })
    expect(res.status).toBe(202)
    const body = (await res.json()) as { jobId: string }
    const job = await waitForJob(body.jobId)
    expect(job).toMatchObject({ status: "succeeded" })

    // The redo replaced the old row in place — still exactly one ai-v1 review.
    const rows = (await db.select().from(sessionReviews)).filter(
      (row) => row.sessionId === sessionId,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.summary).toBe("Clean two-message session.")
  })

  test("A11: GET /api/sessions/reviewer-options lists each harness with its default model and availability", async () => {
    const token = await signToken(env, { sub: userId, aud: "web" })
    const res = await buildApp(db, env, {
      aiReviewRunner: fakeRunner,
      aiReviewJobs: registry,
      commandExists: (cmd) => cmd === "opencode",
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
        defaultModel: "zai-coding-plan/glm-5.3-flash",
        available: true,
        models: ["zai-coding-plan/glm-5.3-flash", "fake-model"],
      },
      {
        harness: "claude",
        defaultModel: "sonnet",
        available: false,
        models: ["sonnet", "opus", "haiku"],
      },
    ])
  })
})
