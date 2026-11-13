import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { eq } from "drizzle-orm"
import type { Sql } from "postgres"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import type { Db } from "./client.js"
import { messages, projects, reviewProblems, sessionReviews, sessions, users } from "./schema.js"
import { dockerAvailable, startTestDb } from "./testDb.js"

describe.skipIf(!dockerAvailable())("the problem seenAt migration", () => {
  let teardown: () => Promise<void>
  let db: Db
  let client: Sql

  beforeAll(async () => {
    const started = await startTestDb()
    db = started.db
    client = started.client
    teardown = started.teardown
  }, 120_000)

  afterAll(async () => {
    await teardown?.()
  })

  /** The migration's backfill alone: the column already exists in a migrated test database. */
  const backfill = async () => {
    const file = readFileSync(
      new URL("../../migrations/0050_problem_seen_at.sql", import.meta.url),
      "utf8",
    )
    const [, update] = file.split("--> statement-breakpoint")
    await client.unsafe(update as string)
  }

  const savedAt = new Date("2026-11-10T12:00:00.000Z")

  const seed = async () => {
    const [user] = await db
      .insert(users)
      .values({
        githubId: 800_000 + Math.floor(Math.random() * 1_000_000),
        githubLogin: "seen-user",
      })
      .returning()
    const [project] = await db
      .insert(projects)
      .values({ name: "seen", slug: `seen-${randomUUID()}`, ownerUserId: user?.id as string })
      .returning()
    const sessionId = `seen-${randomUUID()}`
    await db.insert(sessions).values({
      id: sessionId,
      source: "claude_code",
      userId: user?.id as string,
      projectId: project?.id as string,
      lastMessageAt: savedAt,
    })
    const message = async (lineNumber: number, timestamp: Date | null) => {
      const [row] = await db
        .insert(messages)
        .values({
          sessionId,
          lineUuid: randomUUID(),
          subIndex: 0,
          msgType: "message",
          role: "user",
          content: { text: "hi" },
          lineNumber,
          raw: {},
          sourceSchemaVersion: 1,
          timestamp,
        })
        .returning({ id: messages.id })
      return row?.id as string
    }
    const review = async (recordIds: ReadonlyArray<string | null> | null) => {
      const [row] = await db
        .insert(sessionReviews)
        .values({
          sessionId,
          projectId: project?.id as string,
          analyzer: "ai-problems-v2",
          status: "done",
          outcome: "shipped",
          summary: "s",
          signals: recordIds === null ? {} : { run: { recordIds } },
        })
        .returning()
      return row?.id as string
    }
    const problem = async (reviewId: string, froms: ReadonlyArray<string>) => {
      const [row] = await db
        .insert(reviewProblems)
        .values({
          reviewId,
          sessionId,
          projectId: project?.id as string,
          position: 0,
          title: "t",
          class: "missed",
          severity: "low",
          severityReason: "r",
          fixType: "code",
          description: "d",
          evidence: froms.map((from) => ({ from, to: from, quote: "q", why: "w" })),
          learning: "l",
          createdAt: savedAt,
          seenAt: savedAt,
        })
        .returning({ id: reviewProblems.id })
      return row?.id as string
    }
    return { message, review, problem }
  }

  const seenAt = async (id: string) => {
    const [row] = await db
      .select({ seenAt: reviewProblems.seenAt })
      .from(reviewProblems)
      .where(eq(reviewProblems.id, id))
    return row?.seenAt.toISOString()
  }

  test("an old problem is seen at the earliest message its evidence cites, or when it was saved", async () => {
    const { message, review, problem } = await seed()
    const early = await message(1, new Date("2026-11-01T09:00:00.000Z"))
    const later = await message(2, new Date("2026-11-03T09:00:00.000Z"))
    const untimed = await message(3, null)
    const withOrder = await review([null, early, later, untimed])

    const cited = await problem(withOrder, ["msg-2", "msg-1"])
    const outsideOrder = await problem(withOrder, ["msg-9"])
    const noTime = await problem(withOrder, ["msg-3"])
    const notAMessage = await problem(withOrder, ["call-4"])
    const noOrder = await problem(await review(null), ["msg-1"])

    await backfill()

    expect(await seenAt(cited)).toBe("2026-11-01T09:00:00.000Z")
    for (const id of [outsideOrder, noTime, notAMessage, noOrder])
      expect(await seenAt(id)).toBe(savedAt.toISOString())
  })
})
