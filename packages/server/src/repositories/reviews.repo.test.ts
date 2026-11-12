import { afterAll, beforeAll, describe, expect, test } from "vitest"
import type { Db } from "../db/client.js"
import { messages, sessionReviews, users } from "../db/schema.js"
import { dockerAvailable, startTestDb } from "../db/testDb.js"
import * as projectsRepo from "./projects.repo.js"
import * as reviewsRepo from "./reviews.repo.js"
import * as sessionsRepo from "./sessions.repo.js"

describe.skipIf(!dockerAvailable())("reviews repository", () => {
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

  const seedSession = async (sessionId: string) => {
    const [user] = await db
      .insert(users)
      .values({
        githubId: 5100 + Math.floor(Math.random() * 1_000_000),
        githubLogin: `reviews-repo-${sessionId}`,
      })
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
    return { userId: user.id, projectId }
  }

  const seedMessage = async (
    sessionId: string,
    values: { msgType?: string; timestamp: Date | null; lineNumber: number; createdAt?: Date },
  ) => {
    const [row] = await db
      .insert(messages)
      .values({
        sessionId,
        lineUuid: crypto.randomUUID(),
        subIndex: 0,
        msgType: values.msgType ?? "message",
        role: (values.msgType ?? "message") === "message" ? "user" : null,
        lineNumber: values.lineNumber,
        raw: {},
        sourceSchemaVersion: 1,
        timestamp: values.timestamp,
        ...(values.createdAt === undefined ? {} : { createdAt: values.createdAt }),
      })
      .returning({ id: messages.id })
    if (!row) throw new Error("seed message failed")
    return row.id
  }

  test("SC19: token reports and turn markers after a done run are not new; a message at a later timestamp is", async () => {
    const sessionId = "new-messages"
    const { projectId } = await seedSession(sessionId)
    const last = await seedMessage(sessionId, {
      timestamp: new Date("2026-01-01T10:00:00Z"),
      lineNumber: 1,
    })
    const [run] = await db
      .insert(sessionReviews)
      .values({
        sessionId,
        projectId,
        analyzer: "ai-problems-v2",
        status: "done",
        outcome: "shipped",
        summary: "s",
        signals: {},
        lastMessageId: last,
      })
      .returning()
    if (!run) throw new Error("seed run failed")
    const later = new Date("2026-01-01T11:00:00Z")
    await seedMessage(sessionId, { msgType: "usage", timestamp: later, lineNumber: 2 })
    await seedMessage(sessionId, { msgType: "turnEvent", timestamp: later, lineNumber: 3 })

    expect(await reviewsRepo.hasNewMessagesSince(db, sessionId, run.id)).toBe(false)
    expect(await reviewsRepo.latestDoneRun(db, sessionId, "ai-problems-v2")).toMatchObject({
      id: run.id,
    })

    await seedMessage(sessionId, { timestamp: later, lineNumber: 4 })
    expect(await reviewsRepo.hasNewMessagesSince(db, sessionId, run.id)).toBe(true)
  })

  const doneRun = async (
    sessionId: string,
    projectId: string,
    values: { lastMessageId: string | null; updatedAt: Date },
  ) => {
    const [run] = await db
      .insert(sessionReviews)
      .values({
        sessionId,
        projectId,
        analyzer: "ai-problems-v2",
        status: "done",
        outcome: "shipped",
        summary: "s",
        signals: {},
        ...values,
      })
      .returning()
    if (!run) throw new Error("seed run failed")
    return run.id
  }

  test("an untimed message stored before the run finished is not new; one stored after it is", async () => {
    const sessionId = "untimed-new-messages"
    const { projectId } = await seedSession(sessionId)
    const last = await seedMessage(sessionId, {
      timestamp: new Date("2026-01-01T10:00:00Z"),
      lineNumber: 1,
    })
    const runId = await doneRun(sessionId, projectId, {
      lastMessageId: last,
      updatedAt: new Date("2026-01-01T12:00:00Z"),
    })
    await seedMessage(sessionId, {
      timestamp: null,
      lineNumber: 2,
      createdAt: new Date("2026-01-01T11:00:00Z"),
    })
    expect(await reviewsRepo.hasNewMessagesSince(db, sessionId, runId)).toBe(false)

    await seedMessage(sessionId, {
      timestamp: null,
      lineNumber: 3,
      createdAt: new Date("2026-01-01T13:00:00Z"),
    })
    expect(await reviewsRepo.hasNewMessagesSince(db, sessionId, runId)).toBe(true)
  })

  test("a run that read nothing (no lastMessageId) makes any timed message new, however early", async () => {
    const sessionId = "read-nothing"
    const { projectId } = await seedSession(sessionId)
    const runId = await doneRun(sessionId, projectId, {
      lastMessageId: null,
      updatedAt: new Date("2026-01-01T12:00:00Z"),
    })
    await seedMessage(sessionId, {
      msgType: "usage",
      timestamp: new Date("2000-01-01T00:00:00Z"),
      lineNumber: 1,
    })
    expect(await reviewsRepo.hasNewMessagesSince(db, sessionId, runId)).toBe(false)

    await seedMessage(sessionId, { timestamp: new Date("2000-01-01T00:00:00Z"), lineNumber: 2 })
    expect(await reviewsRepo.hasNewMessagesSince(db, sessionId, runId)).toBe(true)
  })

  test("SC5: the page shows the latest done full run and the done new-part runs after it; failed and waiting runs never show", async () => {
    const sessionId = "review-chain"
    const { userId, projectId } = await seedSession(sessionId)
    const done = { outcome: "shipped", summary: "s", signals: {} }
    const run = async (
      name: string,
      minute: number,
      values: { status: string; newPartOnly?: boolean } & Partial<typeof done>,
    ) => {
      const [row] = await db
        .insert(sessionReviews)
        .values({
          sessionId,
          projectId,
          analyzer: "ai-problems-v2",
          summary: name,
          createdAt: new Date(Date.UTC(2026, 0, 1, 10, minute)),
          ...values,
        })
        .returning()
      if (!row) throw new Error(`seed ${name} failed`)
    }
    const shown = async () =>
      (await reviewsRepo.listReviewsForSession(db, userId, sessionId)).map((row) => row.summary)

    await run("A", 1, { ...done, summary: "A", status: "done" })
    await run("B", 2, { ...done, summary: "B", status: "done", newPartOnly: true })
    await run("C", 3, { ...done, summary: "C", status: "done", newPartOnly: true })
    await run("D", 4, { status: "failed" })
    expect(await shown()).toEqual(["C", "B", "A"])

    await run("E", 5, { ...done, summary: "E", status: "done" })
    await run("F", 6, { ...done, summary: "F", status: "done", newPartOnly: true })
    await run("G", 7, { status: "waiting", newPartOnly: true })
    expect(await shown()).toEqual(["F", "E"])
  })
})

describe("lastMessageRead", () => {
  const message = (id: string, trackId: string, lineNumber: number, timestamp: string | null) => ({
    id,
    trackId,
    lineNumber,
    timestamp,
  })
  const main9 = message("main-9", "main", 9, "2026-01-01T10:00:00.000Z")
  const sub2 = message("sub-2", "agent:a1", 2, "2026-01-01T10:05:00.000Z")
  const main10 = message("main-10", "main", 10, null)

  test.each([
    {
      name: "main line 9 at 10:00, a subagent's line 2 at 10:05 and an untimed main line 10",
      messages: [main9, sub2, main10],
      expected: "sub-2",
    },
    {
      name: "no timestamps: main lines 9 and 10 beside a subagent's line 40",
      messages: [
        message("main-9", "main", 9, null),
        message("sub-40", "agent:a1", 40, null),
        message("main-10", "main", 10, null),
      ],
      expected: "main-10",
    },
    { name: "no messages", messages: [], expected: null },
  ])("SC1: $name were read last at $expected", ({ messages, expected }) => {
    expect(reviewsRepo.lastMessageRead(messages)).toBe(expected)
  })
})
