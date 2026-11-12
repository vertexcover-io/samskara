import pino from "pino"
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest"
import { buildApp } from "../app.js"
import type { Db } from "../db/client.js"
import {
  learningRuns,
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
  learningsHarness: { path: "/harness" },
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
  let projectC: string
  let notified: number

  beforeEach(async () => {
    await db.delete(sessionReviews)
    await db.delete(messages)
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
    const [a, b, c] = await db
      .insert(projects)
      .values([
        { name: "Project A", slug: "a", ownerUserId: userId },
        { name: "Project B", slug: "b", ownerUserId: otherUserId },
        { name: "Project C", slug: "c", ownerUserId: userId },
      ])
      .returning({ id: projects.id })
    projectA = a?.id as string
    projectB = b?.id as string
    projectC = c?.id as string
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
      { id: "c-1", source: "claude_code", userId, projectId: projectC, title: "c one" },
    ])
    notified = 0
  })

  const request = async (
    path: string,
    init: {
      readonly method?: string
      readonly body?: unknown
      readonly credentialEnv?: NodeJS.ProcessEnv
      /** False runs the server with no learnings harness, so no fix run can be queued. */
      readonly harness?: boolean
    } = {},
  ): Promise<Response> => {
    const token = await signToken(env, { sub: userId, aud: "web" })
    const appEnv = init.harness === false ? { ...env, learningsHarness: undefined } : env
    return buildApp(db, appEnv, {
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

  const start = (
    sessionIds: ReadonlyArray<string>,
    credentialEnv?: NodeJS.ProcessEnv,
    options: { readonly harness?: boolean } = {},
  ) =>
    request("/api/review-batches", {
      method: "POST",
      body: { sessionIds },
      ...(credentialEnv === undefined ? {} : { credentialEnv }),
      ...options,
    })

  const rows = () => db.select().from(sessionReviews)
  const fixRuns = () => db.select().from(learningRuns)

  test("SC24: pressing Review on ticked sessions queues each one and wakes the worker once", async () => {
    const res = await start(["a-1", "a-2", "a-3"])

    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ queued: 3, skipped: 0, notAllowed: [], fixRunsQueued: 1 })
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
    expect(await res.json()).toEqual({
      queued: 1,
      skipped: 1,
      notAllowed: ["b-1", "missing"],
      fixRunsQueued: 1,
    })
    const byId = new Map((await rows()).map((row) => [row.sessionId, row]))
    expect(byId.get("a-1")).toMatchObject({ status: "done", summary: "done before" })
    expect(byId.get("a-2")).toMatchObject({ status: "waiting" })
    expect(byId.has("b-1")).toBe(false)
  })

  /**
   * a-1 never reviewed; a-2 reviewed at 10:00 with a message at 11:00; a-3 reviewed with nothing
   * after; c-1 with a run waiting. Returns the done runs of a-2 and a-3.
   */
  const seedFourStates = async () => {
    const message = async (sessionId: string, lineNumber: number, at: string) => {
      const [row] = await db
        .insert(messages)
        .values({
          sessionId,
          lineUuid: crypto.randomUUID(),
          subIndex: 0,
          msgType: "message",
          role: "user",
          lineNumber,
          raw: {},
          sourceSchemaVersion: 1,
          content: { type: "text", value: "hi" },
          timestamp: new Date(at),
        })
        .returning({ id: messages.id })
      return row?.id ?? null
    }
    const doneRun = async (sessionId: string, lastMessageId: string | null) => {
      const [row] = await db
        .insert(sessionReviews)
        .values({
          sessionId,
          projectId: projectA,
          analyzer: PROBLEMS_ANALYZER,
          outcome: "productive",
          summary: "done before",
          signals: {},
          lastMessageId,
        })
        .returning()
      return row?.id as string
    }
    await message("a-1", 1, "2026-01-01T10:00:00Z")
    const grown = await doneRun("a-2", await message("a-2", 1, "2026-01-01T10:00:00Z"))
    await message("a-2", 2, "2026-01-01T11:00:00Z")
    const still = await doneRun("a-3", await message("a-3", 1, "2026-01-01T10:00:00Z"))
    await db.insert(sessionReviews).values({
      sessionId: "c-1",
      projectId: projectC,
      analyzer: PROBLEMS_ANALYZER,
      status: "waiting",
    })
    return { grown, still }
  }

  const waitingRows = async () =>
    (await rows())
      .filter((row) => row.status === "waiting" && row.sessionId !== "c-1")
      .map((row) => [row.sessionId, row.newPartOnly, row.basedOn])
      .sort()

  test("SC25: new-messages mode gives a never-reviewed session a full run and a grown one a new-part run, and skips one with nothing new or a run waiting", async () => {
    const { grown } = await seedFourStates()

    const res = await request("/api/review-batches", {
      method: "POST",
      body: { sessionIds: ["a-1", "a-2", "a-3", "c-1"], mode: "newMessages" },
    })

    expect(await res.json()).toEqual({ queued: 2, skipped: 2, notAllowed: [], fixRunsQueued: 2 })
    expect(await waitingRows()).toEqual([
      ["a-1", false, null],
      ["a-2", true, grown],
    ])
    expect((await rows()).filter((row) => row.sessionId === "c-1")).toHaveLength(1)
  })

  test("SC26: full mode queues a full run for every ticked session, reviewed or not, and skips one with a run waiting", async () => {
    await seedFourStates()

    const res = await request("/api/review-batches", {
      method: "POST",
      body: { sessionIds: ["a-1", "a-2", "a-3", "c-1"], mode: "full" },
    })

    expect(await res.json()).toEqual({ queued: 3, skipped: 1, notAllowed: [], fixRunsQueued: 2 })
    expect(await waitingRows()).toEqual([
      ["a-1", false, null],
      ["a-2", false, null],
      ["a-3", false, null],
    ])
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

    expect(await res.json()).toEqual({ queued: 1, skipped: 0, notAllowed: [], fixRunsQueued: 1 })
  })

  test("one fix run is queued per project with queued reviews, and it waits for them", async () => {
    const res = await start(["a-1", "a-2", "c-1"])

    expect(await res.json()).toMatchObject({ queued: 3, fixRunsQueued: 2 })
    const runs = await fixRuns()
    expect(runs.map((run) => run.projectId).sort()).toEqual([projectA, projectC].sort())
    expect(
      runs.every(
        (run) => run.status === "waiting" && run.waitForReviews && run.harnessPath === null,
      ),
    ).toBe(true)
    expect(notified).toBe(1)
  })

  test("a project whose ticked sessions were all skipped or refused gets no fix run", async () => {
    await db.insert(sessionReviews).values({
      sessionId: "a-1",
      projectId: projectA,
      analyzer: PROBLEMS_ANALYZER,
      outcome: "productive",
      summary: "done before",
      signals: {},
    })

    const res = await start(["a-1", "b-1", "c-1"])

    expect(await res.json()).toMatchObject({ queued: 1, fixRunsQueued: 1 })
    expect((await fixRuns()).map((run) => run.projectId)).toEqual([projectC])
  })

  test("a session whose review is already running is skipped, but its project still gets a fix run that waits for it", async () => {
    await db.insert(sessionReviews).values({
      sessionId: "c-1",
      projectId: projectC,
      analyzer: PROBLEMS_ANALYZER,
      status: "running",
      attempts: 1,
    })

    const res = await start(["c-1"])

    expect(await res.json()).toEqual({ queued: 0, skipped: 1, notAllowed: [], fixRunsQueued: 1 })
    expect((await rows()).filter((row) => row.sessionId === "c-1")).toHaveLength(1)
    expect(await fixRuns()).toEqual([
      expect.objectContaining({ projectId: projectC, status: "waiting", waitForReviews: true }),
    ])
  })

  test("pressing twice reuses the waiting fix run instead of adding a second", async () => {
    await start(["a-1"])
    const again = await start(["a-2"])

    expect(await again.json()).toMatchObject({ fixRunsQueued: 1 })
    const runs = await fixRuns()
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ projectId: projectA, status: "waiting" })
  })

  test("a fix run already running is left alone and not counted", async () => {
    await db.insert(learningRuns).values({ projectId: projectA, status: "running" })

    const res = await start(["a-1"])

    expect(await res.json()).toEqual({ queued: 1, skipped: 0, notAllowed: [], fixRunsQueued: 0 })
    const runs = await fixRuns()
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ status: "running" })
  })

  test("a server with no learnings harness queues the reviews but no fix run", async () => {
    const res = await start(["a-1"], undefined, { harness: false })

    expect(await res.json()).toEqual({ queued: 1, skipped: 0, notAllowed: [], fixRunsQueued: 0 })
    expect(await rows()).toHaveLength(1)
    expect(await fixRuns()).toEqual([])
  })
})
