import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { eq } from "drizzle-orm"
import type { Sql } from "postgres"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import type { Db } from "./client.js"
import { messages, projects, sessions, users } from "./schema.js"
import { dockerAvailable, startTestDb } from "./testDb.js"

describe.skipIf(!dockerAvailable())("task notification subtype backfill", () => {
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

  const migration = readFileSync(
    new URL("../../migrations/0026_task_notification_subtype.sql", import.meta.url),
    "utf8",
  )
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0)

  const run = () =>
    client.begin(async (tx) => {
      for (const statement of migration) await tx.unsafe(statement)
    })

  const seedUser = async () => {
    const [user] = await db
      .insert(users)
      .values({
        githubId: 900_000 + Math.floor(Math.random() * 1_000_000),
        githubLogin: "backfill-user",
      })
      .returning()
    if (!user) throw new Error("seed user failed")
    return user
  }

  const seedProject = async (ownerUserId: string) => {
    const [project] = await db
      .insert(projects)
      .values({ name: "backfill-project", slug: `backfill-${randomUUID()}`, ownerUserId })
      .returning()
    if (!project) throw new Error("seed project failed")
    return project
  }

  const seedSession = async (projectId: string, userId: string) => {
    const id = `backfill-sess-${randomUUID()}`
    await db.insert(sessions).values({ id, source: "claude_code", userId, projectId })
    return id
  }

  let lineNumber = 0
  const seedMessage = async (sessionId: string, raw: unknown, subType: string | null = null) => {
    lineNumber += 1
    const [message] = await db
      .insert(messages)
      .values({
        sessionId,
        lineUuid: randomUUID(),
        subIndex: 0,
        msgType: "message",
        subType,
        role: "user",
        content: { text: "hi" },
        lineNumber,
        raw,
        sourceSchemaVersion: 1,
      })
      .returning()
    if (!message) throw new Error("seed message failed")
    return message
  }

  test("SC11: only the rows an older CLI mislabelled are changed", async () => {
    const user = await seedUser()
    const project = await seedProject(user.id)
    const session = await seedSession(project.id, user.id)

    const taskNotificationRaw = {
      type: "attachment",
      attachment: { type: "queued_command", commandMode: "task-notification" },
    }
    const promptRaw = {
      type: "attachment",
      attachment: { type: "queued_command", commandMode: "prompt" },
    }
    const noCommandModeRaw = {
      type: "attachment",
      attachment: { type: "queued_command" },
    }

    const taskNotificationMessage = await seedMessage(session, taskNotificationRaw)
    const promptMessage = await seedMessage(session, promptRaw)
    const noCommandModeMessage = await seedMessage(session, noCommandModeRaw)
    const alreadyTypedMessage = await seedMessage(session, taskNotificationRaw, "somethingElse")

    await run()

    const [taskNotificationAfter] = await db
      .select()
      .from(messages)
      .where(eq(messages.id, taskNotificationMessage.id))
    const [promptAfter] = await db.select().from(messages).where(eq(messages.id, promptMessage.id))
    const [noCommandModeAfter] = await db
      .select()
      .from(messages)
      .where(eq(messages.id, noCommandModeMessage.id))
    const [alreadyTypedAfter] = await db
      .select()
      .from(messages)
      .where(eq(messages.id, alreadyTypedMessage.id))

    expect(taskNotificationAfter?.subType).toBe("taskNotification")
    expect(promptAfter?.subType).toBeNull()
    expect(noCommandModeAfter?.subType).toBeNull()
    expect(alreadyTypedAfter?.subType).toBe("somethingElse")

    expect(taskNotificationAfter?.content).toEqual(taskNotificationMessage.content)
    expect(taskNotificationAfter?.role).toBe(taskNotificationMessage.role)
    expect(taskNotificationAfter?.raw).toEqual(taskNotificationMessage.raw)
  })

  test("SC12: replaying the repair changes nothing further", async () => {
    const user = await seedUser()
    const project = await seedProject(user.id)
    const session = await seedSession(project.id, user.id)

    const taskNotificationRaw = {
      type: "attachment",
      attachment: { type: "queued_command", commandMode: "task-notification" },
    }
    const message = await seedMessage(session, taskNotificationRaw)

    await run()
    const [afterFirst] = await db.select().from(messages).where(eq(messages.id, message.id))

    await run()
    const [afterSecond] = await db.select().from(messages).where(eq(messages.id, message.id))

    expect(afterSecond?.subType).toBe(afterFirst?.subType)
  })
})
