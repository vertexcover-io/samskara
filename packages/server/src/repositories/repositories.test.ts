import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { type Db, createDb } from "../db/client.js"
import { projects, sessions, subagents, tokenUsage, toolCall, users } from "../db/schema.js"
import * as messagesRepo from "./messages.repo.js"
import * as projectsRepo from "./projects.repo.js"
import * as sessionsRepo from "./sessions.repo.js"
import * as subagentsRepo from "./subagents.repo.js"
import * as tokenUsageRepo from "./tokenUsage.repo.js"
import * as toolRowsRepo from "./toolRows.repo.js"

const dockerAvailable = () => {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

const packageDir = fileURLToPath(new URL("../..", import.meta.url))

describe.skipIf(!dockerAvailable())("ingest repositories", () => {
  let container: StartedPostgreSqlContainer
  let teardown: () => Promise<void>
  let db: Db

  let counter = 0
  const seedUser = async () => {
    counter += 1
    const [user] = await db
      .insert(users)
      .values({ githubId: 500 + counter, githubLogin: `repo-user-${counter}` })
      .returning()
    if (!user) throw new Error("seed user failed")
    return user
  }

  const seedSession = async (id: string) => {
    const user = await seedUser()
    const projectId = await projectsRepo.upsert(db, {
      identity: { name: id, slug: `slug-${id}` },
      ownerId: user.id,
    })
    await sessionsRepo.upsert(db, {
      id,
      source: "claude_code",
      userId: user.id,
      projectId,
      fields: { title: "initial title" },
    })
    return { userId: user.id, projectId }
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg16").start()
    const url = container.getConnectionUri()
    execFileSync("bun", ["run", "db:migrate"], {
      cwd: packageDir,
      env: { ...process.env, DATABASE_URL: url },
      stdio: "inherit",
    })
    const created = createDb(url)
    db = created.db
    teardown = async () => {
      await created.client.end()
      await container.stop()
    }
  }, 120_000)

  afterAll(async () => {
    await teardown?.()
  })

  test("sessions.upsert enriches the title without changing id; null keeps existing", async () => {
    const { userId, projectId } = await seedSession("sess-repo-enrich")
    // A non-null title on a later flush wins (coalesce excluded first).
    await sessionsRepo.upsert(db, {
      id: "sess-repo-enrich",
      source: "claude_code",
      userId,
      projectId,
      fields: { title: "later title" },
    })
    // A flush with no title keeps the existing one.
    await sessionsRepo.upsert(db, {
      id: "sess-repo-enrich",
      source: "claude_code",
      userId,
      projectId,
      fields: {},
    })
    const [row] = await db.select().from(sessions).where(eq(sessions.id, "sess-repo-enrich"))
    expect(row?.title).toBe("later title")
    expect(await sessionsRepo.exists(db, "sess-repo-enrich")).toBe(true)
    expect(await sessionsRepo.exists(db, "nope")).toBe(false)
  })

  test("projects.upsert is idempotent per (slug, ownerId) and refreshes name", async () => {
    const owner = await seedUser()
    const first = await projectsRepo.upsert(db, {
      identity: { name: "widget", slug: "acme-widget" },
      ownerId: owner.id,
    })
    const second = await projectsRepo.upsert(db, {
      identity: { name: "widget-renamed", slug: "acme-widget" },
      ownerId: owner.id,
    })
    expect(first).toBe(second)

    const rows = await db.select().from(projects).where(eq(projects.id, first))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.name).toBe("widget-renamed")
  })

  test("authorization is owner-or-grant with ordered scopes", async () => {
    const owner = await seedUser()
    const editorUser = await seedUser()
    const viewerUser = await seedUser()
    const stranger = await seedUser()
    const projectId = await projectsRepo.upsert(db, {
      identity: { name: "shared", slug: "shared-proj" },
      ownerId: owner.id,
    })

    // Owner is admin by derivation, with no grant row.
    expect(await projectsRepo.authorityFor(db, owner.id, projectId)).toBe("admin")
    expect(await projectsRepo.canWrite(db, owner.id, projectId)).toBe(true)

    await projectsRepo.grant(db, editorUser.id, projectId, "editor")
    await projectsRepo.grant(db, viewerUser.id, projectId, "viewer")

    // editor implies viewer (ordered: viewer < editor < admin).
    expect(await projectsRepo.canWrite(db, editorUser.id, projectId)).toBe(true)
    expect(await projectsRepo.canRead(db, editorUser.id, projectId)).toBe(true)

    // viewer can read but not write.
    expect(await projectsRepo.canRead(db, viewerUser.id, projectId)).toBe(true)
    expect(await projectsRepo.canWrite(db, viewerUser.id, projectId)).toBe(false)

    // stranger sees nothing.
    expect(await projectsRepo.authorityFor(db, stranger.id, projectId)).toBeNull()
    expect(await projectsRepo.canRead(db, stranger.id, projectId)).toBe(false)
  })

  test("subagents.upsert without meta then with meta upgrades labels (I5)", async () => {
    await seedSession("sess-sub")
    await subagentsRepo.upsert(db, {
      sessionId: "sess-sub",
      sourceRelativePath: "subagents/agent-a.jsonl",
      agent: { agentId: "agent-a" },
    })
    await subagentsRepo.upsert(db, {
      sessionId: "sess-sub",
      sourceRelativePath: "subagents/agent-a.jsonl",
      agent: { agentId: "agent-a", agentType: "Explore", spawnDepth: 1 },
    })
    await subagentsRepo.upsert(db, {
      sessionId: "sess-sub",
      sourceRelativePath: "subagents/agent-a.jsonl",
      agent: { agentId: "agent-a" },
    })
    const [row] = await db.select().from(subagents).where(eq(subagents.agentId, "agent-a"))
    expect(row?.agentType).toBe("Explore")
    expect(row?.spawnDepth).toBe(1)
  })

  test("messages.insertManyIgnoreConflicts dedupes and returns a stable id map", async () => {
    await seedSession("sess-msg")
    const rows = [
      {
        sessionId: "sess-msg",
        lineUuid: "0191d942-3ba5-7dba-9a7d-22d65b3025b7",
        subIndex: 0,
        msgType: "message",
        lineNumber: 1,
        sourceSchemaVersion: 1,
        raw: {},
      },
      {
        sessionId: "sess-msg",
        lineUuid: "0191d942-3ba5-7dba-9a7d-22d65b3025b7",
        subIndex: 1,
        msgType: "toolCall",
        lineNumber: 1,
        sourceSchemaVersion: 1,
        raw: {},
      },
    ] as const

    const first = await messagesRepo.insertManyIgnoreConflicts(db, "sess-msg", [...rows])
    expect(first.ingested).toBe(2)
    expect(first.deduped).toBe(0)

    const second = await messagesRepo.insertManyIgnoreConflicts(db, "sess-msg", [...rows])
    expect(second.ingested).toBe(0)
    expect(second.deduped).toBe(2)
    expect(second.idByKey.get(messagesRepo.keyOf("0191d942-3ba5-7dba-9a7d-22d65b3025b7", 0))).toBe(
      first.idByKey.get(messagesRepo.keyOf("0191d942-3ba5-7dba-9a7d-22d65b3025b7", 0)),
    )
  })

  test("toolRows.replaceForMessage is delete-and-replace", async () => {
    await seedSession("sess-tool")
    const { idByKey } = await messagesRepo.insertManyIgnoreConflicts(db, "sess-tool", [
      {
        sessionId: "sess-tool",
        lineUuid: "0191d942-3ba5-7dba-9a7d-22d65b3025b8",
        subIndex: 0,
        msgType: "toolCall",
        lineNumber: 1,
        sourceSchemaVersion: 1,
        raw: {},
      },
    ])
    const messageId = idByKey.get(messagesRepo.keyOf("0191d942-3ba5-7dba-9a7d-22d65b3025b8", 0))
    if (!messageId) throw new Error("no message id")

    await toolRowsRepo.replaceForMessage(db, messageId, {
      call: { callId: "toolu_1", name: "Read", input: { path: "a" } },
    })
    await toolRowsRepo.replaceForMessage(db, messageId, {
      call: { callId: "toolu_1", name: "Read", input: { path: "b" } },
    })
    const calls = await db.select().from(toolCall).where(eq(toolCall.messageId, messageId))
    expect(calls).toHaveLength(1)
    expect(calls[0]?.toolInput).toEqual({ path: "b" })
  })

  test("tokenUsage.upsert overwrites the counts for a message rather than adding a row", async () => {
    await seedSession("sess-tokens")
    const { idByKey } = await messagesRepo.insertManyIgnoreConflicts(db, "sess-tokens", [
      {
        sessionId: "sess-tokens",
        lineUuid: "0191d942-3ba5-7dba-9a7d-22d65b3025b9",
        subIndex: 0,
        msgType: "usage",
        lineNumber: 1,
        sourceSchemaVersion: 1,
        raw: {},
      },
    ])
    const messageId = idByKey.get(messagesRepo.keyOf("0191d942-3ba5-7dba-9a7d-22d65b3025b9", 0))
    if (!messageId) throw new Error("no message id")

    await tokenUsageRepo.upsert(db, messageId, { input: 1, output: 2, cached: 0, thinking: 0 })
    await tokenUsageRepo.upsert(db, messageId, { input: 9, output: 2, cached: 3, thinking: 4 })

    const rows = await db.select().from(tokenUsage).where(eq(tokenUsage.messageId, messageId))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ inputTokens: 9, cachedTokens: 3, thinkingTokens: 4 })
  })
})
