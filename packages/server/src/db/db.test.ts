import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import { and, eq, sql } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { type Db, createDb } from "./client.js"
import {
  messages,
  orgRepos,
  orgs,
  repos,
  sessions,
  subagents,
  tokenUsage,
  toolCall,
  toolResult,
  userOrgs,
  userRepos,
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

  test("inserts entities, links them, and reverse-looks-up repo visibility", async () => {
    const [user] = await db
      .insert(users)
      .values({ githubId: 1, githubLogin: "vertexcover" })
      .returning()
    const [org] = await db
      .insert(orgs)
      .values({ githubSlug: "refrens", githubOrgId: 42 })
      .returning()
    const [remoteRepo] = await db
      .insert(repos)
      .values({ host: "github", owner: "refrens", ownerType: "org", repoName: "andromeda" })
      .returning()
    const [localRepo] = await db
      .insert(repos)
      .values({
        host: "local",
        owner: "vertexcover",
        ownerType: "user",
        repoName: "/Users/x/work/myapp",
      })
      .returning()

    if (!user || !org || !remoteRepo || !localRepo) throw new Error("insert returned no row")

    await db.insert(userOrgs).values({ userId: user.id, orgId: org.id })
    await db.insert(userRepos).values([
      { userId: user.id, repoId: remoteRepo.id },
      { userId: user.id, repoId: localRepo.id },
    ])
    await db.insert(orgRepos).values({ orgId: org.id, repoId: remoteRepo.id })

    const visibleUsers = await db
      .select({ id: users.id, login: users.githubLogin })
      .from(userRepos)
      .innerJoin(users, eq(users.id, userRepos.userId))
      .where(eq(userRepos.repoId, remoteRepo.id))

    expect(visibleUsers).toHaveLength(1)
    expect(visibleUsers[0]?.login).toBe("vertexcover")
  })

  test("UNIQUE rejects a duplicate repo identity but allows a different local path", async () => {
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
    const [repo] = await db
      .insert(repos)
      .values({
        host: "local",
        owner: "vertexcover",
        ownerType: "user",
        repoName: `/work/app-${seedCounter}`,
      })
      .returning()
    if (!user || !repo) throw new Error("seed insert returned no row")
    return { user, repo }
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
    const { user, repo } = await seed()
    const [session] = await db
      .insert(sessions)
      .values({ id, source: "claude_code", userId: user.id, repoId: repo.id })
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
        lineUuid: "line-1",
        subIndex: 0,
        msgType: "assistant",
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
        lineUuid: "line-1",
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
        lineUuid: "sub-line-1",
        subIndex: 0,
        msgType: "assistant",
        lineNumber: 1,
        sourceSchemaVersion: 1,
        isSubagent: true,
        agentId: "agent-x",
        raw: { kind: "subagent" },
      },
      {
        sessionId: session.id,
        lineUuid: "sub-line-2",
        subIndex: 0,
        msgType: "assistant",
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
      lineUuid: "dupe-line",
      subIndex: 0,
      msgType: "user" as const,
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
        lineUuid: "bad-line",
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
        lineUuid: "status-line",
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
