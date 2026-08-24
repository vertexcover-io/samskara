import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import { and, eq, sql } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { type Db, createDb } from "./client.js"
import {
  commits,
  messages,
  orgs,
  projects,
  pullRequests,
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

  test("updated_at trigger advances the timestamp on UPDATE", async () => {
    const [owner] = await db
      .insert(users)
      .values({ githubId: 13, githubLogin: "repo-owner" })
      .returning()
    if (!owner) throw new Error("insert returned no row")

    const [repo] = await db
      .insert(repos)
      .values({ host: "github", owner: "acme", repoName: "trigger-probe", userId: owner.id })
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

  const seedRepo = async (userId: string, repoName: string) => {
    const [repo] = await db
      .insert(repos)
      .values({ host: "github.com", owner: "acme", repoName, userId })
      .returning()
    if (!repo) throw new Error("repo insert returned no row")
    return repo
  }

  const seedMessage = async (sessionId: string, repoId: string) => {
    const [message] = await db
      .insert(messages)
      .values({
        sessionId,
        lineUuid: randomUUID(),
        subIndex: 0,
        msgType: "message",
        lineNumber: 1,
        raw: {},
        sourceSchemaVersion: 1,
        repoId,
      })
      .returning()
    if (!message) throw new Error("message insert returned no row")
    return message
  }

  test("deleting a repo keeps its messages and clears their repo pointer", async () => {
    const session = await seedSession("sess-repo-delete")
    const repo = await seedRepo(session.userId, "widget")
    const message = await seedMessage(session.id, repo.id)

    await db.delete(repos).where(eq(repos.id, repo.id))

    const [row] = await db.select().from(messages).where(eq(messages.id, message.id))
    expect(row).toBeDefined()
    expect(row?.repoId).toBeNull()
  })

  test("deleting a user keeps another user's message that pointed at that user's repo", async () => {
    const session = await seedSession("sess-cross-user-repo")
    const { user: repoOwner } = await seed()
    const repo = await seedRepo(repoOwner.id, "shared")
    const message = await seedMessage(session.id, repo.id)

    // repos cascade from users, so this reaches messages.repoId through the repo row.
    await db.delete(users).where(eq(users.id, repoOwner.id))

    const [row] = await db.select().from(messages).where(eq(messages.id, message.id))
    expect(row).toBeDefined()
    expect(row?.repoId).toBeNull()
  })

  test("deleting a repo still removes its commits and pull requests", async () => {
    const session = await seedSession("sess-repo-cascade")
    const repo = await seedRepo(session.userId, "cascade")
    await db.insert(commits).values({ repoId: repo.id, sha: "abc123", sessionId: session.id })
    await db.insert(pullRequests).values({ repoId: repo.id, number: 1 })

    await db.delete(repos).where(eq(repos.id, repo.id))

    expect(await db.select().from(commits).where(eq(commits.repoId, repo.id))).toEqual([])
    expect(await db.select().from(pullRequests).where(eq(pullRequests.repoId, repo.id))).toEqual([])
  })
})
