import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import * as sessionsRepo from "../repositories/sessions.repo.js"
import { createDb, type Db } from "./client.js"
import {
  commits,
  messages,
  orgs,
  projects,
  pullRequests,
  repos,
  sessions,
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

    await db.insert(projects).values({ name: "widget", slug: "acme-widget", ownerUserId: a.id })
    const [mine] = await db
      .insert(projects)
      .values({ name: "widget", slug: "acme-widget", ownerUserId: b.id })
      .returning()
    expect(mine).toBeDefined()

    await expect(
      db.insert(projects).values({ name: "widget", slug: "acme-widget", ownerUserId: a.id }),
    ).rejects.toThrow()
  })

  test("S12: the updatedAt trigger advances the timestamp on UPDATE for users, orgs and repos", async () => {
    const [owner] = await db
      .insert(users)
      .values({ githubId: 13, githubLogin: "repo-owner" })
      .returning()
    const [org] = await db.insert(orgs).values({ githubSlug: "trigger-probe-org" }).returning()
    if (!owner || !org) throw new Error("insert returned no row")

    const [repo] = await db
      .insert(repos)
      .values({ host: "github", owner: "acme", repoName: "trigger-probe", userId: owner.id })
      .returning()
    if (!repo) throw new Error("insert returned no row")

    const [updatedOwner] = await db
      .update(users)
      .set({ name: "renamed" })
      .where(eq(users.id, owner.id))
      .returning()
    const [updatedOrg] = await db
      .update(orgs)
      .set({ name: "renamed" })
      .where(eq(orgs.id, org.id))
      .returning()
    const [updatedRepo] = await db
      .update(repos)
      .set({ owner: "acme-renamed" })
      .where(eq(repos.id, repo.id))
      .returning()

    type Timestamps = { readonly createdAt: Date; readonly updatedAt: Date }
    const pairs: ReadonlyArray<readonly [Timestamps, Timestamps | undefined]> = [
      [owner, updatedOwner],
      [org, updatedOrg],
      [repo, updatedRepo],
    ]

    for (const [before, after] of pairs) {
      if (!after) throw new Error("update returned no row")
      expect(before.updatedAt.getTime()).toBe(before.createdAt.getTime())
      expect(after.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime())
      expect(after.createdAt.getTime()).toBe(before.createdAt.getTime())
    }
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
      .values({ name: `app-${seedCounter}`, slug: `slug-${seedCounter}`, ownerUserId: user.id })
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

  // The three raw `sql` templates behind this call spell the renamed columns as strings, where
  // neither the type checker nor a Drizzle query builder can see them.
  test("S14: the session list and its repo filter options still carry repoName and userLogin", async () => {
    const session = await seedSession("sess-raw-sql-names")
    const repo = await seedRepo(session.userId, "raw-sql-probe")
    await seedMessage(session.id, repo.id)

    const { rows, filterOptions } = await sessionsRepo.listAccessible(db, session.userId)

    const row = rows.find((candidate) => candidate.id === session.id)
    expect(row?.repo?.repoName).toBe("raw-sql-probe")
    expect(row?.userLogin).toMatch(/^user-/)
    expect(filterOptions.repositories.map((option) => option.repoName)).toContain("raw-sql-probe")
    expect(filterOptions.authors.map((option) => option.value)).toContain(row?.userLogin)
  })

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
