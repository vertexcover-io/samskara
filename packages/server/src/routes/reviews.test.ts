import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest"
import { buildApp } from "../app.js"
import type { Db } from "../db/client.js"
import {
  learnings as learningsTable,
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
describe.skipIf(localServerUrl() === undefined && !dockerAvailable())(
  "reviews and learnings",
  () => {
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
    const sessionId = "review-test-session"

    beforeEach(async () => {
      await db.delete(sessionReviews)
      await db.delete(learningsTable)
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

    test("V3: review writes learnings for both audiences, deduped by fingerprint", async () => {
      await seedErrorLoop()
      await db.insert(messages).values({
        sessionId,
        lineUuid: crypto.randomUUID(),
        subIndex: 0,
        msgType: "message",
        role: "user",
        lineNumber: 99,
        source: "claude_code",
        sourceRelativePath: "test.jsonl",
        trackId: "main",
        raw: {},
        sourceSchemaVersion: 1,
        content: { type: "text", value: "stop retrying" },
        details: {},
      })
      await request(`/api/sessions/${sessionId}/review`, { method: "POST" })
      // Second review of the same session: same fingerprints, and occurrenceCount stays 1 —
      // occurrences are per distinct session, so a re-review must not inflate them.
      await request(`/api/sessions/${sessionId}/review`, { method: "POST" })

      const res = await request(`/api/learnings?projectId=${projectId}`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        learnings: ReadonlyArray<{
          audience: string
          category: string
          occurrenceCount: number
          status: string
        }>
      }
      expect(
        body.learnings.some((l) => l.audience === "agent" && l.category === "tool-retry"),
      ).toBe(true)
      expect(body.learnings.some((l) => l.audience === "human")).toBe(true)
      for (const learning of body.learnings) {
        expect(learning.occurrenceCount).toBe(1)
        expect(learning.status).toBe("candidate")
      }
    })

    test("V13: occurrenceCount is per distinct session, and the title keeps the max-seen magnitude", async () => {
      const seeded = new Set<string>()
      const seedSessionWithLoop = async (sid: string, failures: number) => {
        if (!seeded.has(sid)) {
          seeded.add(sid)
          await db.insert(sessions).values({
            id: sid,
            source: "claude_code",
            userId,
            projectId,
            title: sid,
          })
          await line(sid, 1, "message", "user", { type: "text", value: "fix the build" }, {})
          for (let i = 0; i < failures; i += 1) {
            const callId = `call-${sid}-${i}`
            await line(sid, 2 + i * 2, "toolCall", null, null, {
              callId,
              name: "Bash",
              input: { command: "npm test" },
            })
            await line(sid, 3 + i * 2, "toolResult", null, null, {
              callId,
              output: "",
              status: "failure",
            })
          }
        }
        const res = await request(`/api/sessions/${sid}/review`, { method: "POST" })
        expect(res.status).toBe(201)
      }

      // Session A: first sighting — count 1, title carries the 3-failure magnitude.
      await seedSessionWithLoop("review-test-loop-a", 3)
      // Session B: a NEW distinct session — count 2, and its 5-failure title is strictly
      // larger, so it takes over.
      await seedSessionWithLoop("review-test-session-b", 5)
      // Re-review of session B: idempotent — the count must not move.
      await seedSessionWithLoop("review-test-session-b", 5)
      // Session C: new session (count 3) but a smaller magnitude (4 < 5) — the title must
      // not regress to "4 times".
      await seedSessionWithLoop("review-test-session-c", 4)

      const res = await request(`/api/learnings?projectId=${projectId}`)
      const body = (await res.json()) as {
        learnings: { category: string; occurrenceCount: number; title: string }[]
      }
      const retry = body.learnings.find((l) => l.category === "tool-retry")
      expect(retry?.occurrenceCount).toBe(3)
      expect(retry?.title).toBe("Bash failed 5 times in a row")
    })

    test("V4: learnings filter by audience and status", async () => {
      await seedErrorLoop()
      await request(`/api/sessions/${sessionId}/review`, { method: "POST" })
      const agents = await request(`/api/learnings?audience=agent`)
      const agentBody = (await agents.json()) as { learnings: { audience: string }[] }
      expect(agentBody.learnings.length).toBeGreaterThan(0)
      for (const learning of agentBody.learnings) expect(learning.audience).toBe("agent")
    })

    test("V5: PATCH /api/learnings/:id/status moves candidate to accepted and back", async () => {
      await seedErrorLoop()
      await request(`/api/sessions/${sessionId}/review`, { method: "POST" })
      const listed = await request(`/api/learnings?projectId=${projectId}`)
      const { learnings } = (await listed.json()) as { learnings: { id: string }[] }
      const target = learnings[0]
      expect(target).toBeDefined()

      const patched = await request(`/api/learnings/${target?.id}/status`, {
        method: "PATCH",
        body: { status: "accepted" },
      })
      expect(patched.status).toBe(200)
      const body = (await patched.json()) as { learning: { status: string } }
      expect(body.learning.status).toBe("accepted")

      const invalid = await request(`/api/learnings/${target?.id}/status`, {
        method: "PATCH",
        body: { status: "wat" },
      })
      expect(invalid.status).toBe(400)
    })

    test("V6: reviewing a missing session returns 404", async () => {
      const res = await request("/api/sessions/does-not-exist/review", { method: "POST" })
      expect(res.status).toBe(404)
    })

    test("V7: learnings from a project the viewer cannot see stay invisible", async () => {
      const [stranger] = await db
        .insert(users)
        .values({ githubId: 2, githubLogin: "stranger" })
        .returning({ id: users.id })
      const [hidden] = await db
        .insert(projects)
        .values({ name: "Hidden", slug: "hidden", ownerUserId: stranger?.id as string })
        .returning({ id: projects.id })
      await db.insert(learningsTable).values({
        projectId: hidden?.id as string,
        audience: "agent",
        category: "tool-retry",
        title: "Stranger's lesson",
        detail: "Not yours to read.",
        evidence: [],
        fingerprint: "stranger-fp",
      })

      const mine = await request("/api/learnings")
      const body = (await mine.json()) as { learnings: { title: string }[] }
      expect(body.learnings.some((l) => l.title === "Stranger's lesson")).toBe(false)

      const direct = await request(`/api/learnings?projectId=${hidden?.id}`)
      expect(direct.status).toBe(200)
      const directBody = (await direct.json()) as { learnings: unknown[] }
      expect(directBody.learnings).toHaveLength(0)
    })

    test("V8: a non-editor cannot change a learning's status", async () => {
      await seedErrorLoop()
      await request(`/api/sessions/${sessionId}/review`, { method: "POST" })
      const listed = await request(`/api/learnings?projectId=${projectId}`)
      const { learnings } = (await listed.json()) as { learnings: { id: string }[] }
      const target = learnings[0]
      expect(target).toBeDefined()

      const [stranger] = await db
        .insert(users)
        .values({ githubId: 3, githubLogin: "viewer-only" })
        .returning({ id: users.id })
      await db.insert(userProjectGrant).values({
        userId: stranger?.id as string,
        projectId,
        scope: "viewer",
      })
      const strangerToken = await signToken(env, { sub: stranger?.id as string, aud: "web" })
      const res = await buildApp(db, env).request(`/api/learnings/${target?.id}/status`, {
        method: "PATCH",
        headers: { cookie: `session=${strangerToken}`, "content-type": "application/json" },
        body: JSON.stringify({ status: "accepted" }),
      })
      expect(res.status).toBe(403)

      const owner = await request(`/api/learnings/${target?.id}/status`, {
        method: "PATCH",
        body: { status: "accepted" },
      })
      expect(owner.status).toBe(200)
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

    test("V11: GET /api/sessions/:id/learnings lists lessons whose latest provenance is this session", async () => {
      await db.insert(sessionReviews).values({
        sessionId,
        projectId,
        analyzer: "heuristic-v1",
        outcome: "struggled",
        friction: "high",
        summary: "struggled: 4 turns",
        signals: {},
      })
      const [here] = await db.select().from(sessionReviews).limit(1)
      await db.insert(sessions).values({
        id: "review-test-other",
        source: "claude_code",
        userId,
        projectId,
        title: "other session",
      })
      const [elsewhere] = await db
        .insert(sessionReviews)
        .values({
          sessionId: "review-test-other",
          projectId,
          analyzer: "heuristic-v1",
          outcome: "shipped",
          friction: "none",
          summary: "shipped: 1 turn",
          signals: {},
        })
        .returning({ id: sessionReviews.id })
      await db.insert(learningsTable).values([
        {
          projectId,
          audience: "agent",
          category: "tool-retry",
          title: "Seen in this session",
          detail: "Sourced here.",
          evidence: [],
          fingerprint: "here-fp",
          sourceReviewId: here?.id as string,
        },
        {
          projectId,
          audience: "human",
          category: "supervision",
          title: "Seen in the other session",
          detail: "Sourced elsewhere.",
          evidence: [],
          fingerprint: "elsewhere-fp",
          sourceReviewId: elsewhere?.id as string,
        },
      ])

      const res = await request(`/api/sessions/${sessionId}/learnings`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        learnings: { fingerprint: string; occurrenceCount: number }[]
      }
      expect(body.learnings.some((l) => l.fingerprint === "here-fp")).toBe(true)
      expect(body.learnings.every((l) => l.fingerprint !== "elsewhere-fp")).toBe(true)
    })

    test("V12: GET /api/sessions/:id/learnings 404s when the session is invisible or missing", async () => {
      const [stranger] = await db
        .insert(users)
        .values({ githubId: 5, githubLogin: "hidden-session-owner" })
        .returning({ id: users.id })
      const [hidden] = await db
        .insert(projects)
        .values({ name: "HiddenToo", slug: "hidden-too", ownerUserId: stranger?.id as string })
        .returning({ id: projects.id })
      const hiddenSessionId = "hidden-learnings-session"
      await db.insert(sessions).values({
        id: hiddenSessionId,
        source: "claude_code",
        userId: stranger?.id as string,
        projectId: hidden?.id as string,
        title: "hidden session",
      })

      const invisible = await request(`/api/sessions/${hiddenSessionId}/learnings`)
      expect(invisible.status).toBe(404)
      expect(await invisible.json()).toEqual({ error: "sessionNotFound" })

      const missing = await request("/api/sessions/does-not-exist/learnings")
      expect(missing.status).toBe(404)
      expect(await missing.json()).toEqual({ error: "sessionNotFound" })
    })

    test("V9: the same lesson in two projects appears once in the common view", async () => {
      const [second] = await db
        .insert(projects)
        .values({ name: "Second", slug: "second", ownerUserId: userId })
        .returning({ id: projects.id })
      const shared = { audience: "agent", category: "tool-retry", evidence: [] }
      await db.insert(learningsTable).values([
        {
          ...shared,
          projectId,
          fingerprint: "shared-fp",
          title: "Bash failed 3 times in a row",
          detail: "Change approach.",
        },
        {
          ...shared,
          projectId: second?.id as string,
          fingerprint: "shared-fp",
          title: "Bash failed 3 times in a row",
          detail: "Change approach.",
        },
        {
          ...shared,
          projectId,
          fingerprint: "solo-fp",
          title: "Only here",
          detail: "Single project.",
        },
      ] as (typeof learningsTable.$inferInsert)[])

      const res = await request("/api/learnings/common")
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        learnings: { fingerprint: string; projectCount: number; projectNames: string[] }[]
      }
      const sharedRow = body.learnings.find((l) => l.fingerprint === "shared-fp")
      expect(sharedRow).toBeDefined()
      expect(sharedRow?.projectCount).toBe(2)
      expect(sharedRow?.projectNames).toEqual(["P", "Second"])
      expect(body.learnings.some((l) => l.fingerprint === "solo-fp")).toBe(false)
    })
  },
)
