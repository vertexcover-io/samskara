import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import { and, eq, sql } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { type Db, createDb } from "./client.js"
import {
  messages,
  orgs,
  projects,
  repos,
  sessions,
  subagents,
  tokenUsage,
  toolCall,
  toolResult,
  userOrgs,
  userProjectGrant,
  users,
} from "./schema.js"

const dockerAvailable = () => {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

const packageDir = fileURLToPath(new URL("../..", import.meta.url))

describe.skipIf(!dockerAvailable())("identity mesh schema", () => {
  let container: StartedPostgreSqlContainer
  let teardown: () => Promise<void>
  let db: Db

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

  test("inserts entities, links them, and reverse-looks-up project visibility", async () => {
    const [user] = await db
      .insert(users)
      .values({ githubId: 1, githubLogin: "vertexcover" })
      .returning()
    const [other] = await db
      .insert(users)
      .values({ githubId: 2, githubLogin: "teammate" })
      .returning()
    const [org] = await db
      .insert(orgs)
      .values({ githubSlug: "refrens", githubOrgId: 42 })
      .returning()

    if (!user || !other || !org) throw new Error("insert returned no row")

    await db.insert(userOrgs).values({ userId: user.id, orgId: org.id })

    const [project] = await db
      .insert(projects)
      .values({ name: "andromeda", slug: "refrens-andromeda", ownerId: user.id })
      .returning()
    if (!project) throw new Error("project insert returned no row")

    // Owner is admin by derivation and has NO grant row; grants elevate OTHER users.
    await db.insert(userProjectGrant).values({
      userId: other.id,
      projectId: project.id,
      scope: "viewer",
    })

    const grantedUsers = await db
      .select({ login: users.githubLogin })
      .from(userProjectGrant)
      .innerJoin(users, eq(users.id, userProjectGrant.userId))
      .where(eq(userProjectGrant.projectId, project.id))

    expect(grantedUsers).toHaveLength(1)
    expect(grantedUsers[0]?.login).toBe("teammate")
  })

  test("UNIQUE(slug, ownerId) allows the same slug for two different owners", async () => {
    const [a] = await db.insert(users).values({ githubId: 11, githubLogin: "owner-a" }).returning()
    const [b] = await db.insert(users).values({ githubId: 12, githubLogin: "owner-b" }).returning()
    if (!a || !b) throw new Error("insert returned no row")

    await db.insert(projects).values({ name: "widget", slug: "acme-widget", ownerId: a.id })
    const [mine] = await db
      .insert(projects)
      .values({ name: "widget", slug: "acme-widget", ownerId: b.id })
      .returning()
    expect(mine).toBeDefined()

    await expect(
      db.insert(projects).values({ name: "widget", slug: "acme-widget", ownerId: a.id }),
    ).rejects.toThrow()
  })

  test("userProjectGrant.scope CHECK rejects an invalid scope", async () => {
    const [u] = await db
      .insert(users)
      .values({ githubId: 13, githubLogin: "scope-user" })
      .returning()
    if (!u) throw new Error("insert returned no row")
    const [p] = await db
      .insert(projects)
      .values({ name: "proj", slug: "scope-proj", ownerId: u.id })
      .returning()
    if (!p) throw new Error("project insert returned no row")

    await expect(
      db.insert(userProjectGrant).values({ userId: u.id, projectId: p.id, scope: "owner" }),
    ).rejects.toThrow()
  })

  test("UNIQUE rejects a duplicate repo identity but allows a different local path", async () => {
    await db
      .insert(repos)
      .values({ host: "github", owner: "refrens", ownerType: "org", repoName: "andromeda" })
    await expect(
      db
        .insert(repos)
        .values({ host: "github", owner: "refrens", ownerType: "org", repoName: "andromeda" }),
    ).rejects.toThrow()

    const [other] = await db
      .insert(repos)
      .values({
        host: "local",
        owner: "vertexcover",
        ownerType: "user",
        repoName: "/Users/x/other/myapp",
      })
      .returning()

    expect(other).toBeDefined()
  })

  test("owner_type CHECK rejects an invalid value", async () => {
    await expect(
      db
        .insert(repos)
        .values({ host: "github", owner: "acme", ownerType: "team", repoName: "widget" }),
    ).rejects.toThrow()
  })

  test("updated_at trigger advances the timestamp on UPDATE", async () => {
    const [repo] = await db
      .insert(repos)
      .values({ host: "github", owner: "acme", ownerType: "org", repoName: "trigger-probe" })
      .returning()

    if (!repo) throw new Error("insert returned no row")
    expect(repo.updatedAt.getTime()).toBe(repo.createdAt.getTime())

    const [updated] = await db
      .update(repos)
      .set({ owner: "acme-renamed" })
      .where(and(eq(repos.id, repo.id)))
      .returning()

    if (!updated) throw new Error("update returned no row")
    expect(updated.updatedAt.getTime()).toBeGreaterThan(repo.updatedAt.getTime())
    expect(updated.createdAt.getTime()).toBe(repo.createdAt.getTime())
  })
})

describe.skipIf(!dockerAvailable())("session data model", () => {
  let container: StartedPostgreSqlContainer
  let teardown: () => Promise<void>
  let db: Db

  let seedCounter = 0
  const seed = async () => {
    seedCounter += 1
    const [user] = await db
      .insert(users)
      .values({ githubId: 100 + seedCounter, githubLogin: `user-${seedCounter}` })
      .returning()
    if (!user) throw new Error("seed user returned no row")
    const [project] = await db
      .insert(projects)
      .values({ name: `app-${seedCounter}`, slug: `slug-${seedCounter}`, ownerId: user.id })
      .returning()
    if (!project) throw new Error("seed project returned no row")
    return { user, project }
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

  const seedSession = async (id: string) => {
    const { user, project } = await seed()
    const [session] = await db
      .insert(sessions)
      .values({ id, source: "claude_code", userId: user.id, projectId: project.id })
      .returning()
    if (!session) throw new Error("session insert returned no row")
    return session
  }

  test("stores fanned-out messages, tool rows, a subagent, and token totals", async () => {
    const session = await seedSession("sess-abc")

    const [assistant] = await db
      .insert(messages)
      .values({
        sessionId: session.id,
        lineUuid: "0191d942-3ba5-7dba-9a7d-22d65b3025b1",
        subIndex: 0,
        msgType: "message",
        role: "assistant",
        lineNumber: 1,
        sourceSchemaVersion: 1,
        raw: { kind: "assistant" },
      })
      .returning()
    if (!assistant) throw new Error("message insert returned no row")

    const [call] = await db
      .insert(messages)
      .values({
        sessionId: session.id,
        lineUuid: "0191d942-3ba5-7dba-9a7d-22d65b3025b1",
        subIndex: 1,
        msgType: "toolCall",
        lineNumber: 1,
        sourceSchemaVersion: 1,
        raw: { kind: "assistant" },
      })
      .returning()
    if (!call) throw new Error("toolCall message insert returned no row")

    await db
      .insert(toolCall)
      .values({ toolId: "toolu_1", messageId: call.id, toolName: "Read", toolInput: { path: "x" } })
    await db
      .insert(toolResult)
      .values({ toolId: "toolu_1", messageId: call.id, result: "ok", status: "success" })

    await db.insert(messages).values([
      {
        sessionId: session.id,
        lineUuid: "0191d942-3ba5-7dba-9a7d-22d65b3025b2",
        subIndex: 0,
        msgType: "message",
        lineNumber: 1,
        sourceSchemaVersion: 1,
        isSubagent: true,
        agentId: "agent-x",
        raw: { kind: "subagent" },
      },
      {
        sessionId: session.id,
        lineUuid: "0191d942-3ba5-7dba-9a7d-22d65b3025b3",
        subIndex: 0,
        msgType: "message",
        lineNumber: 2,
        sourceSchemaVersion: 1,
        isSubagent: true,
        agentId: "agent-x",
        raw: { kind: "subagent" },
      },
    ])

    await db.insert(subagents).values({
      agentId: "agent-x",
      sessionId: session.id,
      agentType: "Explore",
      spawnDepth: 1,
      sourceRelativePath: "subagents/agent-x.jsonl",
    })

    await db.insert(tokenUsage).values({
      messageId: assistant.id,
      inputTokens: 120,
      outputTokens: 45,
      cachedTokens: 10,
      thinkingTokens: 5,
    })

    const [totals] = await db
      .select({
        input: sql<number>`coalesce(sum(${tokenUsage.inputTokens}), 0)::int`,
        output: sql<number>`coalesce(sum(${tokenUsage.outputTokens}), 0)::int`,
      })
      .from(tokenUsage)
      .innerJoin(messages, eq(messages.id, tokenUsage.messageId))
      .where(eq(messages.sessionId, session.id))

    expect(totals).toEqual({ input: 120, output: 45 })

    const subagentLines = await db
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.sessionId, session.id), eq(messages.agentId, "agent-x")))
    expect(subagentLines).toHaveLength(2)

    const [derivedResult] = await db
      .select({ toolId: toolResult.toolId })
      .from(toolResult)
      .where(eq(toolResult.messageId, call.id))
    expect(derivedResult?.toolId).toBe("toolu_1")
  })

  test("UNIQUE(lineUuid, subIndex) dedupes but allows a new subIndex", async () => {
    const session = await seedSession("sess-dupe")

    const line = {
      sessionId: session.id,
      lineUuid: "0191d942-3ba5-7dba-9a7d-22d65b3025b4",
      subIndex: 0,
      msgType: "message" as const,
      lineNumber: 1,
      sourceSchemaVersion: 1,
      raw: {},
    }
    await db.insert(messages).values(line)
    await expect(db.insert(messages).values({ ...line, lineNumber: 2 })).rejects.toThrow()

    const [second] = await db
      .insert(messages)
      .values({ ...line, subIndex: 1 })
      .returning()
    expect(second).toBeDefined()
  })

  test("messages.msgType CHECK rejects a bad value", async () => {
    const session = await seedSession("sess-badtype")

    await expect(
      db.insert(messages).values({
        sessionId: session.id,
        lineUuid: "0191d942-3ba5-7dba-9a7d-22d65b3025b5",
        subIndex: 0,
        msgType: "banana",
        lineNumber: 1,
        sourceSchemaVersion: 1,
        raw: {},
      }),
    ).rejects.toThrow()
  })

  test("toolResult.status CHECK rejects a bad value", async () => {
    const session = await seedSession("sess-badstatus")
    const [msg] = await db
      .insert(messages)
      .values({
        sessionId: session.id,
        lineUuid: "0191d942-3ba5-7dba-9a7d-22d65b3025b6",
        subIndex: 0,
        msgType: "toolResult",
        lineNumber: 1,
        sourceSchemaVersion: 1,
        raw: {},
      })
      .returning()
    if (!msg) throw new Error("message insert returned no row")

    await expect(
      db.insert(toolResult).values({ toolId: "t1", messageId: msg.id, status: "pending" }),
    ).rejects.toThrow()
  })

  test("subagents row persists with no meta fields (I5)", async () => {
    const session = await seedSession("sess-nometa")
    const [row] = await db
      .insert(subagents)
      .values({
        agentId: "agent-nometa",
        sessionId: session.id,
        sourceRelativePath: "subagents/agent-nometa.jsonl",
      })
      .returning()
    expect(row?.agentType).toBeNull()
  })

  test("updatedAt trigger advances on a sessions UPDATE", async () => {
    const session = await seedSession("sess-trigger")
    expect(session.updatedAt.getTime()).toBe(session.createdAt.getTime())

    const [updated] = await db
      .update(sessions)
      .set({ title: "renamed" })
      .where(eq(sessions.id, session.id))
      .returning()
    if (!updated) throw new Error("update returned no row")

    expect(updated.updatedAt.getTime()).toBeGreaterThan(session.updatedAt.getTime())
    expect(updated.createdAt.getTime()).toBe(session.createdAt.getTime())
  })
})
