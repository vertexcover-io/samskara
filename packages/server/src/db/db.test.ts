import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import { and, eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { type Db, createDb } from "./client.js"
import { orgRepos, orgs, repos, userOrgs, userRepos, users } from "./schema.js"

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
