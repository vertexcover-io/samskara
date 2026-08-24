import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { type Db, createDb } from "../db/client.js"
import {
  messages,
  orgs,
  projects,
  sessions,
  userOrgs,
  userProjectGrant,
  users,
} from "../db/schema.js"
import {
  DEV_ORG_SLUG,
  DEV_PROJECT_SLUG,
  DEV_USER_LOGIN,
  MESSAGES_PER_SESSION,
  copyGithubUsers,
  hasProjects,
  seedDev,
} from "./seed-dev.js"

const dockerAvailable = () => {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

const packageDir = fileURLToPath(new URL("../..", import.meta.url))

describe.skipIf(!dockerAvailable())("seed:dev fills a fresh worktree database", () => {
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
  }, 180_000)

  afterAll(async () => {
    await teardown?.()
  })

  test("creates a signed-in-able user, an org, a project and browsable sessions", async () => {
    const summary = await seedDev(db)

    expect(summary.sessionIds.length).toBeGreaterThanOrEqual(2)
    expect(summary.messages).toBeGreaterThan(0)

    const [user] = await db.select().from(users).where(eq(users.githubLogin, DEV_USER_LOGIN))
    expect(user?.isSuperAdmin).toBe(true)

    const projectRows = await db.select().from(projects).where(eq(projects.id, summary.projectId))
    expect(projectRows).toHaveLength(1)

    const grants = await db
      .select()
      .from(userProjectGrant)
      .where(eq(userProjectGrant.projectId, summary.projectId))
    expect(grants[0]?.scope).toBe("admin")
  })

  test("running twice does not duplicate rows", async () => {
    const first = await seedDev(db)
    const second = await seedDev(db)

    expect(second.projectId).toBe(first.projectId)

    const userRows = await db.select().from(users).where(eq(users.githubLogin, DEV_USER_LOGIN))
    expect(userRows).toHaveLength(1)

    const sessionRows = await db
      .select()
      .from(sessions)
      .where(eq(sessions.projectId, first.projectId))
    expect(sessionRows).toHaveLength(first.sessionIds.length)

    const firstSessionId = first.sessionIds[0]
    if (!firstSessionId) throw new Error("seed produced no sessions")
    const messageRows = await db
      .select()
      .from(messages)
      .where(eq(messages.sessionId, firstSessionId))
    expect(messageRows.length).toBe(MESSAGES_PER_SESSION)
  })

  test("hasProjects tells setup whether this database is still empty", async () => {
    const summary = await seedDev(db)
    expect(summary.projectId).toBeTruthy()
    expect(await hasProjects(db)).toBe(true)
  })

  test("the seeded org is the one seed:org would have registered", async () => {
    const summary = await seedDev(db)
    expect(summary.orgSlug).toBe(DEV_ORG_SLUG)
  })
})

describe.skipIf(!dockerAvailable())("copyGithubUsers carries local identities across", () => {
  let container: StartedPostgreSqlContainer
  let teardown: () => Promise<void>
  let source: Db
  let target: Db

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg16").start()
    const sourceUrl = container.getConnectionUri()
    const targetUrl = new URL(sourceUrl)
    targetUrl.pathname = "/worktree_copy"

    const admin = createDb(sourceUrl)
    await admin.client.unsafe('create database "worktree_copy"')
    await admin.client.end()

    for (const url of [sourceUrl, targetUrl.toString()]) {
      execFileSync("bun", ["run", "db:migrate"], {
        cwd: packageDir,
        env: { ...process.env, DATABASE_URL: url },
        stdio: "inherit",
      })
    }

    const from = createDb(sourceUrl)
    const to = createDb(targetUrl.toString())
    source = from.db
    target = to.db
    teardown = async () => {
      await from.client.end()
      await to.client.end()
      await container.stop()
    }
  }, 240_000)

  afterAll(async () => {
    await teardown?.()
  })

  test("keeps the uuid, so a cookie minted against the source still verifies", async () => {
    const [real] = await source
      .insert(users)
      .values({ githubId: 3_336_623, githubLogin: "kgritesh", name: "Ritesh" })
      .returning()
    if (!real) throw new Error("could not create the source user")
    const [org] = await source
      .insert(orgs)
      .values({ githubSlug: "vertexcover-io", autoAddMembers: true })
      .returning()
    if (!org) throw new Error("could not create the source org")
    await source.insert(userOrgs).values({ userId: real.id, orgId: org.id })

    await seedDev(target)
    const result = await copyGithubUsers(source, target)

    expect(result.copied[0]?.targetId).toBe(real.id)
    expect(result.copied[0]?.idPreserved).toBe(true)

    const [landed] = await target.select().from(users).where(eq(users.id, real.id))
    expect(landed?.githubLogin).toBe("kgritesh")
  })

  test("carries org membership across so org-owned projects stay visible", async () => {
    await copyGithubUsers(source, target)
    const [org] = await target.select().from(orgs).where(eq(orgs.githubSlug, "vertexcover-io"))
    expect(org).toBeDefined()
    const memberships = await target
      .select()
      .from(userOrgs)
      .where(eq(userOrgs.orgId, org?.id ?? ""))
    expect(memberships).toHaveLength(1)
  })

  test("grants admin on the demo project so the seeded data is actually browsable", async () => {
    await copyGithubUsers(source, target)
    const [demo] = await target.select().from(projects).where(eq(projects.slug, DEV_PROJECT_SLUG))
    const [user] = await target.select().from(users).where(eq(users.githubLogin, "kgritesh"))
    const grants = await target
      .select()
      .from(userProjectGrant)
      .where(eq(userProjectGrant.userId, user?.id ?? ""))
    expect(grants.some((g) => g.projectId === demo?.id && g.scope === "admin")).toBe(true)
  })

  test("running it twice changes nothing", async () => {
    await copyGithubUsers(source, target)
    const before = await target.select().from(users)
    await copyGithubUsers(source, target)
    const after = await target.select().from(users)
    expect(after).toHaveLength(before.length)
  })

  test("kind:all sweeps up every user the local database has", async () => {
    await source
      .insert(users)
      .values({ githubId: 4_444_444, githubLogin: "teammate" })
      .onConflictDoNothing()
    const result = await copyGithubUsers(source, target)
    expect(result.copied.map((u) => u.githubLogin).sort()).toContain("teammate")
  })
})
