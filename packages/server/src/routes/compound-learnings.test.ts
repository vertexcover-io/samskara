import { COMPOUND_LEARNINGS_BATCH_MAX } from "@samskara/core"
import { asc, eq } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest"
import { buildApp } from "../app.js"
import type { Db } from "../db/client.js"
import {
  compoundLearnings,
  messages,
  projects,
  sessions,
  userProjectGrant,
  users,
} from "../db/schema.js"
import { dockerAvailable, startTestDb } from "../db/testDb.js"
import type { Env } from "../lib/env.js"
import { signToken } from "../lib/jwt.js"

const env: Env = {
  githubClientId: "Ov23linvZE00y7VZSI4Y",
  githubClientSecret: "secret",
  publicBaseUrl: "http://localhost:3000",
  webBaseUrl: "http://localhost:8000",
  cookieSecure: false,
  jwtSecret: "test-secret-value",
  jwtExpiresIn: "7d",
  superAdminLogins: [],
  aiReviewHarness: "opencode",
  aiReviewModel: "zai-coding-plan/glm-5.3-flash",
  aiReviewTimeoutMs: 600_000,
}

let githubIds = 0
const seedUser = (db: Db, login: string): Promise<string> => {
  githubIds += 1
  return db
    .insert(users)
    .values({ githubId: githubIds, githubLogin: login })
    .returning({ id: users.id })
    .then(([row]) => {
      if (!row) throw new Error("no seeded user")
      return row.id
    })
}

const event = (overrides: Record<string, unknown> = {}) => ({
  event_id: "evt-1",
  session_id: "sess-not-ingested",
  timestamp: "2026-10-06T12:00:00Z",
  trigger: "manual",
  why_triggered: "user corrected the same mistake twice",
  proposed_learning: "Use absolute paths in worktrees",
  outcome: "new",
  ...overrides,
})

const post = async (
  db: Db,
  body: unknown,
  auth: { userId: string; aud?: "cli" | "web" } | null,
): Promise<{ status: number; body: unknown }> => {
  const headers: Record<string, string> = { "content-type": "application/json" }
  if (auth !== null) {
    const token = await signToken(env, { sub: auth.userId, aud: auth.aud ?? "cli" })
    headers.authorization = `Bearer ${token}`
  }
  const res = await buildApp(db, env).request("/api/compound-learnings", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() }
}

describe.skipIf(!dockerAvailable())("/api/compound-learnings", () => {
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

  describe("POST", () => {
    beforeEach(async () => {
      await db.delete(compoundLearnings)
      await db.delete(users)
    })

    test("a valid batch is stored with every contract field mapped onto its column", async () => {
      const userId = await seedUser(db, "alice")
      const full = event({
        event_id: "evt-full",
        cwd: "/repo",
        evidence_from_message: "0b7e6c1a-4a1e-4c55-9c1e-2f3d5a6b7c8d",
        skill_version: "harness@1.33.1",
        options_shown: ["1. x", "2. y", "3. z"],
        option_user_picked: "2",
        status: "edited",
        final_learning: "final text",
        rejection_reason: "",
        learning_file: "docs/learnings.md",
        replaces: "docs/learnings/old-rule.md",
      })

      const res = await post(db, { events: [full, event({ event_id: "evt-min" })] }, { userId })

      expect(res).toEqual({ status: 200, body: { inserted: 2, skipped: 0 } })
      const rows = await db.select().from(compoundLearnings).orderBy(asc(compoundLearnings.eventId))
      expect(rows).toHaveLength(2)
      expect(rows[0]).toMatchObject({
        eventId: "evt-full",
        userId,
        sessionId: "sess-not-ingested",
        occurredAt: new Date("2026-10-06T12:00:00Z"),
        cwd: "/repo",
        trigger: "manual",
        whyTriggered: "user corrected the same mistake twice",
        evidenceFromMessage: "0b7e6c1a-4a1e-4c55-9c1e-2f3d5a6b7c8d",
        evidenceToMessage: null,
        skillVersion: "harness@1.33.1",
        optionsShown: ["1. x", "2. y", "3. z"],
        proposedLearning: "Use absolute paths in worktrees",
        optionUserPicked: "2",
        outcome: "new",
        status: "edited",
        finalLearning: "final text",
        rejectionReason: null,
        learningFile: "docs/learnings.md",
        replaces: "docs/learnings/old-rule.md",
      })
      expect(rows[1]).toMatchObject({
        eventId: "evt-min",
        cwd: null,
        status: null,
        replaces: null,
      })
    })

    test("empty strings from the skill are stored as null", async () => {
      const userId = await seedUser(db, "alice")
      await post(
        db,
        {
          events: [event({ event_id: "blank", status: "", option_user_picked: "", replaces: "" })],
        },
        { userId },
      )
      const [row] = await db.select().from(compoundLearnings)

      expect(row).toMatchObject({ status: null, optionUserPicked: null, replaces: null })
    })

    test("re-posting an eventId skips it, including a duplicate inside one batch", async () => {
      const userId = await seedUser(db, "alice")
      await post(db, { events: [event()] }, { userId })

      const res = await post(
        db,
        { events: [event(), event({ event_id: "evt-2" }), event({ event_id: "evt-2" })] },
        { userId },
      )

      expect(res).toEqual({ status: 200, body: { inserted: 1, skipped: 2 } })
      expect(await db.select().from(compoundLearnings)).toHaveLength(2)
    })

    test("the same eventId from two different users is stored for each", async () => {
      const alice = await seedUser(db, "alice")
      const bob = await seedUser(db, "bob")

      const fromAlice = await post(db, { events: [event()] }, { userId: alice })
      const fromBob = await post(db, { events: [event()] }, { userId: bob })

      expect(fromAlice.body).toEqual({ inserted: 1, skipped: 0 })
      expect(fromBob.body).toEqual({ inserted: 1, skipped: 0 })
      expect(await db.select().from(compoundLearnings)).toHaveLength(2)
    })

    test("an unknown outcome or trigger is a 400 and stores nothing from the batch", async () => {
      const userId = await seedUser(db, "alice")

      const badOutcome = await post(
        db,
        { events: [event({ event_id: "ok" }), event({ outcome: "maybe" })] },
        { userId },
      )
      const badTrigger = await post(db, { events: [event({ trigger: "cron" })] }, { userId })

      expect(badOutcome.status).toBe(400)
      expect(badTrigger.status).toBe(400)
      expect(await db.select().from(compoundLearnings)).toHaveLength(0)
    })

    test("an empty or oversized batch is a 400", async () => {
      const userId = await seedUser(db, "alice")
      const tooMany = Array.from({ length: COMPOUND_LEARNINGS_BATCH_MAX + 1 }, (_, i) =>
        event({ event_id: `e${i}` }),
      )

      expect((await post(db, { events: [] }, { userId })).status).toBe(400)
      expect((await post(db, { events: tooMany }, { userId })).status).toBe(400)
    })

    test("no token, or a web token, is a 401", async () => {
      const userId = await seedUser(db, "alice")

      expect((await post(db, { events: [event()] }, null)).status).toBe(401)
      expect((await post(db, { events: [event()] }, { userId, aud: "web" })).status).toBe(401)
      expect(await db.select().from(compoundLearnings)).toHaveLength(0)
    })

    test("userId comes from the token, never from the payload", async () => {
      const alice = await seedUser(db, "alice")
      const bob = await seedUser(db, "bob")

      const res = await post(
        db,
        { events: [event({ userId: alice, user_id: alice })] },
        {
          userId: bob,
        },
      )

      expect(res.status).toBe(200)
      const rows = await db
        .select({ userId: compoundLearnings.userId })
        .from(compoundLearnings)
        .where(eq(compoundLearnings.eventId, "evt-1"))
      expect(rows).toEqual([{ userId: bob }])
    })
  })

  const get = async (db: Db, path: string, userId: string) => {
    const token = await signToken(env, { sub: userId, aud: "web" })
    const res = await buildApp(db, env).request(`/api/compound-learnings${path}`, {
      headers: { cookie: `session=${token}` },
    })
    return { status: res.status, body: (await res.json()) as Record<string, unknown> }
  }

  describe("GET", () => {
    let alice: string
    let bob: string
    let projectId: string
    const lineUuids = Array.from({ length: 8 }, () => crypto.randomUUID())

    beforeEach(async () => {
      await db.delete(compoundLearnings)
      await db.delete(messages)
      await db.delete(sessions)
      await db.delete(projects)
      await db.delete(users)
      alice = await seedUser(db, "alice")
      bob = await seedUser(db, "bob")
      const [project] = await db
        .insert(projects)
        .values({ name: "Shop", slug: "shop", ownerUserId: alice })
        .returning({ id: projects.id })
      projectId = project?.id as string
      await db
        .insert(sessions)
        .values({ id: "sess-1", source: "claude_code", userId: alice, projectId })
      await db.insert(messages).values(
        lineUuids.map((lineUuid, index) => ({
          sessionId: "sess-1",
          lineUuid,
          subIndex: 0,
          msgType: "message",
          role: index % 2 === 0 ? "assistant" : "user",
          lineNumber: index + 1,
          source: "claude_code",
          sourceRelativePath: "sess-1.jsonl",
          trackId: "main",
          raw: {},
          sourceSchemaVersion: 1,
          content: { type: "text", value: `line ${index + 1}` },
        })),
      )
    })

    const upload = (userId: string, events: ReadonlyArray<Record<string, unknown>>) =>
      post(db, { events }, { userId })

    test("lists the newest events first, filtered by outcome, status, trigger and version", async () => {
      await upload(alice, [
        event({ event_id: "old", session_id: "sess-1", timestamp: "2026-10-01T00:00:00Z" }),
        event({
          event_id: "new",
          session_id: "sess-1",
          outcome: "rejected",
          status: "rejected",
          skill_version: "harness@1.34.0",
        }),
      ])

      const all = await get(db, "", alice)
      const rejected = await get(db, "?outcome=rejected&status=rejected", alice)
      const versioned = await get(db, "?skillVersion=harness@1.34.0", alice)
      const ids = (body: Record<string, unknown>) =>
        (body.events as Array<{ eventId: string }>).map((e) => e.eventId)

      expect(ids(all.body)).toEqual(["new", "old"])
      expect(all.body.events).toMatchObject([{ userLogin: "alice", projectName: "Shop" }, {}])
      expect(ids(rejected.body)).toEqual(["new"])
      expect(ids(versioned.body)).toEqual(["new"])
      expect((await get(db, "?outcome=maybe", alice)).status).toBe(400)
    })

    test("others see an event only once its session is in a project they can open", async () => {
      await upload(alice, [
        event({ event_id: "ingested", session_id: "sess-1" }),
        event({ event_id: "pending", session_id: "not-yet-ingested" }),
      ])
      const ids = async (userId: string) =>
        ((await get(db, "", userId)).body.events as Array<{ eventId: string }>)
          .map((e) => e.eventId)
          .sort()

      expect(await ids(alice)).toEqual(["ingested", "pending"])
      expect(await ids(bob)).toEqual([])

      await db.insert(userProjectGrant).values({ userId: bob, projectId, scope: "viewer" })

      expect(await ids(bob)).toEqual(["ingested"])
    })

    test("an event naming someone else's session is not linked to it: no project, no messages", async () => {
      await upload(bob, [
        event({ event_id: "spoof", session_id: "sess-1", evidence_to_message: lineUuids[3] }),
      ])
      const [row] = await db.select({ id: compoundLearnings.id }).from(compoundLearnings)

      const asBob = await get(db, `/${row?.id}`, bob)

      expect(asBob.body).toMatchObject({
        event: { projectId: null },
        evidence: [],
        evidenceRange: null,
      })
      expect((await get(db, "", alice)).body.events).toEqual([])
    })

    test("the detail returns the messages from the first evidence message to the last, with context", async () => {
      await upload(alice, [
        event({
          event_id: "e",
          session_id: "sess-1",
          evidence_from_message: lineUuids[3],
          evidence_to_message: lineUuids[4],
        }),
      ])
      const [row] = await db.select({ id: compoundLearnings.id }).from(compoundLearnings)

      const res = await get(db, `/${row?.id}`, alice)

      expect(res.status).toBe(200)
      expect(res.body.evidenceRange).toEqual({ first: 4, last: 5 })
      const lines = (res.body.evidence as Array<{ lineNumber: number }>).map((m) => m.lineNumber)
      expect(lines).toEqual([2, 3, 4, 5, 6, 7])
      expect((await get(db, `/${row?.id}`, bob)).status).toBe(404)
      expect((await get(db, "/not-a-uuid", alice)).status).toBe(400)
    })

    test("an uploader who can no longer open the project still sees the event, but not its project or messages", async () => {
      await upload(bob, [
        event({ event_id: "e", session_id: "sess-bob", evidence_to_message: lineUuids[0] }),
      ])
      await db
        .insert(sessions)
        .values({ id: "sess-bob", source: "claude_code", userId: bob, projectId })
      const [row] = await db.select({ id: compoundLearnings.id }).from(compoundLearnings)

      const res = await get(db, `/${row?.id}`, bob)

      expect(res.status).toBe(200)
      expect(res.body).toMatchObject({
        event: { projectId: null, projectName: null },
        evidence: [],
        evidenceRange: null,
      })
    })

    test("evidence is capped at 100 messages and says so, and subagent lines are left out", async () => {
      const wide = Array.from({ length: 120 }, (_, index) => ({
        sessionId: "sess-1",
        lineUuid: crypto.randomUUID(),
        subIndex: 0,
        msgType: "message",
        role: "user",
        lineNumber: 100 + index,
        source: "claude_code",
        sourceRelativePath: "sess-1.jsonl",
        trackId: "main",
        raw: {},
        sourceSchemaVersion: 1,
        isSubagent: index === 1,
        content: { type: "text", value: `wide ${index}` },
      }))
      await db.insert(messages).values(wide)
      await upload(alice, [
        event({
          event_id: "w",
          session_id: "sess-1",
          evidence_from_message: wide[0]?.lineUuid,
          evidence_to_message: wide[119]?.lineUuid,
        }),
      ])
      const [row] = await db.select({ id: compoundLearnings.id }).from(compoundLearnings)

      const res = await get(db, `/${row?.id}`, alice)
      const lines = (res.body.evidence as Array<{ lineNumber: number }>).map((m) => m.lineNumber)

      expect(res.body.truncated).toBe(true)
      expect(lines).toHaveLength(100)
      expect(lines).not.toContain(101)
    })

    test("without message ids, or before the transcript arrives, the detail has no messages", async () => {
      await upload(alice, [
        event({ event_id: "no-ids", session_id: "sess-1" }),
        event({ event_id: "early", session_id: "later", evidence_to_message: lineUuids[0] }),
      ])
      const rows = await db.select({ id: compoundLearnings.id }).from(compoundLearnings)

      for (const row of rows) {
        const res = await get(db, `/${row.id}`, alice)
        expect(res.body).toMatchObject({ evidence: [], evidenceRange: null })
      }
    })
  })
})
