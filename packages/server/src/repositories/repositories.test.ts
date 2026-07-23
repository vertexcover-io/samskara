import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { type Db, createDb } from "../db/client.js"
import { repos, sessions, subagents, toolCall, users } from "../db/schema.js"
import * as messagesRepo from "./messages.repo.js"
import * as reposRepo from "./repos.repo.js"
import * as sessionsRepo from "./sessions.repo.js"
import * as subagentsRepo from "./subagents.repo.js"
import * as tokenUsageRepo from "./tokenUsage.repo.js"
import * as toolRowsRepo from "./toolRows.repo.js"
import * as userReposRepo from "./userRepos.repo.js"

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
  const seedUserAndRepo = async () => {
    counter += 1
    const [user] = await db
      .insert(users)
      .values({ githubId: 500 + counter, githubLogin: `repo-user-${counter}` })
      .returning()
    if (!user) throw new Error("seed user failed")
    return user
  }

  const seedSession = async (id: string) => {
    const user = await seedUserAndRepo()
    const repoId = await reposRepo.upsertByIdentity(db, {
      host: "local",
      owner: "vertexcover",
      ownerType: "user",
      repoName: `/work/${id}`,
    })
    await sessionsRepo.upsert(db, {
      id,
      source: "claude_code",
      userId: user.id,
      repoId,
      fields: { model: "claude-opus-4-8" },
    })
    return { userId: user.id, repoId }
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

  test("repos.upsertByIdentity is idempotent (same id twice)", async () => {
    const identity = {
      host: "github",
      owner: "acme",
      ownerType: "org",
      repoName: "widget",
    } as const
    const first = await reposRepo.upsertByIdentity(db, identity)
    const second = await reposRepo.upsertByIdentity(db, identity)
    expect(first).toBe(second)

    const all = await db.select({ id: repos.id }).from(repos).where(eq(repos.id, first))
    expect(all).toHaveLength(1)
  })

  test("sessions.upsert enriches without changing id; provider derived", async () => {
    const { userId, repoId } = await seedSession("sess-repo-enrich")
    await sessionsRepo.upsert(db, {
      id: "sess-repo-enrich",
      source: "claude_code",
      userId,
      repoId,
      fields: { title: "later title" },
    })
    const [row] = await db.select().from(sessions).where(eq(sessions.id, "sess-repo-enrich"))
    expect(row?.provider).toBe("anthropic")
    expect(row?.model).toBe("claude-opus-4-8")
    expect(row?.title).toBe("later title")
    expect(await sessionsRepo.exists(db, "sess-repo-enrich")).toBe(true)
    expect(await sessionsRepo.exists(db, "nope")).toBe(false)
  })

  test("userRepos.grant is idempotent", async () => {
    const { userId, repoId } = await seedSession("sess-grant")
    await userReposRepo.grant(db, userId, repoId)
    await userReposRepo.grant(db, userId, repoId)
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
        lineUuid: "l1",
        subIndex: 0,
        msgType: "assistant",
        lineNumber: 1,
        sourceSchemaVersion: 1,
        raw: {},
      },
      {
        sessionId: "sess-msg",
        lineUuid: "l1",
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
    expect(second.idByKey.get(messagesRepo.keyOf("l1", 0))).toBe(
      first.idByKey.get(messagesRepo.keyOf("l1", 0)),
    )
  })

  test("toolRows.replaceForMessage is delete-and-replace", async () => {
    await seedSession("sess-tool")
    const { idByKey } = await messagesRepo.insertManyIgnoreConflicts(db, "sess-tool", [
      {
        sessionId: "sess-tool",
        lineUuid: "tl",
        subIndex: 0,
        msgType: "toolCall",
        lineNumber: 1,
        sourceSchemaVersion: 1,
        raw: {},
      },
    ])
    const messageId = idByKey.get(messagesRepo.keyOf("tl", 0))
    if (!messageId) throw new Error("no message id")

    await toolRowsRepo.replaceForMessage(db, messageId, {
      call: { id: "toolu_1", name: "Read", input: { path: "a" } },
    })
    await toolRowsRepo.replaceForMessage(db, messageId, {
      call: { id: "toolu_1", name: "Read", input: { path: "b" } },
    })
    const calls = await db.select().from(toolCall).where(eq(toolCall.messageId, messageId))
    expect(calls).toHaveLength(1)
    expect(calls[0]?.toolInput).toEqual({ path: "b" })

    await tokenUsageRepo.upsert(db, messageId, { input: 1, output: 2, cached: 0, thinking: 0 })
    await tokenUsageRepo.upsert(db, messageId, { input: 9, output: 2, cached: 0, thinking: 0 })
  })
})
