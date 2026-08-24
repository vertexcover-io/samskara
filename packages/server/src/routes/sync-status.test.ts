import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest"
import { buildApp } from "../app.js"
import { type Db, createDb } from "../db/client.js"
import { orgs, projects, sessions, userOrgs, userProjectGrant, users } from "../db/schema.js"
import type { Env } from "../lib/env.js"
import { signToken } from "../lib/jwt.js"
import * as projectsRepo from "../repositories/projects.repo.js"

const dockerAvailable = () => {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

const packageDir = fileURLToPath(new URL("../..", import.meta.url))

const env: Env = {
  githubClientId: "Ov23linvZE00y7VZSI4Y",
  githubClientSecret: "secret",
  publicBaseUrl: "http://localhost:3000",
  webBaseUrl: "http://localhost:8000",
  cookieSecure: false,
  jwtSecret: "test-secret-value",
  jwtExpiresIn: "7d",
}

type SyncStatusRow = {
  readonly userId: string
  readonly githubLogin: string
  readonly name: string | null
  readonly avatarUrl: string | null
  readonly projectId: string | null
  readonly projectName: string | null
  readonly projectSlug: string | null
  readonly sessionCount: number
  readonly lastSyncedAt: string | null
}

const seedUser = (
  db: Db,
  githubId: number,
  login: string,
  email: string | null = null,
): Promise<string> =>
  db
    .insert(users)
    .values({ githubId, githubLogin: login, email })
    .returning({ id: users.id })
    .then(([row]) => {
      if (!row) throw new Error("no seeded user")
      return row.id
    })

const seedSession = (
  db: Db,
  input: { id: string; userId: string; projectId: string; updatedAt: Date },
) =>
  db.insert(sessions).values({
    id: input.id,
    source: "claude_code",
    userId: input.userId,
    projectId: input.projectId,
    updatedAt: input.updatedAt,
  })

const readAs = async (db: Db, userId: string): Promise<{ status: number; body: unknown }> => {
  const token = await signToken(env, { sub: userId, aud: "web" })
  const res = await buildApp(db, env).request("/api/sync-status", {
    headers: { cookie: `session=${token}` },
  })
  return { status: res.status, body: await res.json() }
}

const rowsAs = async (db: Db, userId: string): Promise<ReadonlyArray<SyncStatusRow>> => {
  const { status, body } = await readAs(db, userId)
  expect(status).toBe(200)
  return (body as { rows: ReadonlyArray<SyncStatusRow> }).rows
}

describe.skipIf(!dockerAvailable())("GET /api/sync-status", () => {
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

  beforeEach(async () => {
    await db.delete(sessions)
    await db.delete(userProjectGrant)
    await db.delete(userOrgs)
    await db.delete(projects)
    await db.delete(orgs)
    await db.delete(users)
  })

  test("S7: every membership the viewer can see returns a row, including a project with no sessions - not a dropped row", async () => {
    const owner = await seedUser(db, 111, "owner-one")
    const p1 = await projectsRepo.upsert(db, {
      identity: { name: "Project One", slug: "project-one" },
      ownerId: owner,
    })
    const p2 = await projectsRepo.upsert(db, {
      identity: { name: "Project Two", slug: "project-two" },
      ownerId: owner,
    })
    const empty = await projectsRepo.upsert(db, {
      identity: { name: "Empty Project", slug: "empty-project" },
      ownerId: owner,
    })
    await seedSession(db, {
      id: "s-1",
      userId: owner,
      projectId: p1,
      updatedAt: new Date("2026-01-01T00:00:00Z"),
    })
    await seedSession(db, {
      id: "s-2",
      userId: owner,
      projectId: p2,
      updatedAt: new Date("2026-01-02T00:00:00Z"),
    })

    const rows = await rowsAs(db, owner)
    expect(rows).toHaveLength(3)
    expect(rows.find((row) => row.projectId === empty)).toMatchObject({
      sessionCount: 0,
      lastSyncedAt: null,
    })
  })

  test("S8: a user who belongs to no project returns exactly one row with null project fields", async () => {
    const lonely = await seedUser(db, 333, "lonely-user")

    const rows = await rowsAs(db, lonely)
    const lonelyRows = rows.filter((row) => row.userId === lonely)

    expect(lonelyRows).toHaveLength(1)
    expect(lonelyRows[0]).toMatchObject({
      projectId: null,
      projectName: null,
      projectSlug: null,
      sessionCount: 0,
      lastSyncedAt: null,
    })
  })

  test("S9: the sync time belongs to that user, not the project - a granted user's own session time, not the owner's", async () => {
    const owner = await seedUser(db, 444, "shared-owner")
    const grantee = await seedUser(db, 555, "shared-grantee")
    const projectId = await projectsRepo.upsert(db, {
      identity: { name: "Shared", slug: "shared" },
      ownerId: owner,
    })
    await projectsRepo.grant(db, grantee, projectId, "viewer")
    await seedSession(db, {
      id: "s-owner",
      userId: owner,
      projectId,
      updatedAt: new Date("2026-01-01T00:00:00Z"),
    })
    await seedSession(db, {
      id: "s-grantee",
      userId: grantee,
      projectId,
      updatedAt: new Date("2026-02-01T00:00:00Z"),
    })

    const rows = await rowsAs(db, owner)
    const ownerRow = rows.find((row) => row.userId === owner && row.projectId === projectId)
    const granteeRow = rows.find((row) => row.userId === grantee && row.projectId === projectId)

    expect(ownerRow?.lastSyncedAt).toBe(new Date("2026-01-01T00:00:00Z").toISOString())
    expect(granteeRow?.lastSyncedAt).toBe(new Date("2026-02-01T00:00:00Z").toISOString())
    expect(ownerRow?.lastSyncedAt).not.toBe(granteeRow?.lastSyncedAt)
  })

  test("S10: a request without a web session is refused, both with no cookie and a cli-audience token", async () => {
    const owner = await seedUser(db, 666, "guarded-owner")
    const app = buildApp(db, env)

    const anonymous = await app.request("/api/sync-status")
    expect(anonymous.status).toBe(401)
    expect(await anonymous.json()).not.toHaveProperty("rows")

    const cliToken = await signToken(env, { sub: owner, aud: "cli" })
    const cli = await app.request("/api/sync-status", {
      headers: { cookie: `session=${cliToken}` },
    })
    expect(cli.status).toBe(401)
    expect(await cli.json()).not.toHaveProperty("rows")
  })

  test("S11: the response never carries an email address, even though every seeded user has one", async () => {
    const owner = await seedUser(db, 777, "emailed-owner", "owner@example.com")

    const { body } = await readAs(db, owner)
    const rows = (body as { rows: ReadonlyArray<Record<string, unknown>> }).rows

    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      expect(row).not.toHaveProperty("email")
    }
    expect(rows[0]?.githubLogin).toBe("emailed-owner")
  })

  test("S12: two projects sharing a slug under different owners stay apart - the viewer sees only their own", async () => {
    const ownerA = await seedUser(db, 888, "slug-owner-a")
    const ownerB = await seedUser(db, 999, "slug-owner-b")
    const projectA = await projectsRepo.upsert(db, {
      identity: { name: "Samskara A", slug: "samskara" },
      ownerId: ownerA,
    })
    await projectsRepo.upsert(db, {
      identity: { name: "Samskara B", slug: "samskara" },
      ownerId: ownerB,
    })

    const rows = await rowsAs(db, ownerA)
    const matching = rows.filter((row) => row.projectSlug === "samskara")

    expect(matching).toHaveLength(1)
    expect(matching[0]).toMatchObject({ projectId: projectA, userId: ownerA })
    expect(rows.some((row) => row.userId === ownerB)).toBe(false)
  })

  test("S79: a project the viewer has no authority over is absent, and so is the stranger who owns it", async () => {
    const viewer = await seedUser(db, 1001, "scoped-viewer")
    const stranger = await seedUser(db, 1002, "stranger")
    const mine = await projectsRepo.upsert(db, {
      identity: { name: "Mine", slug: "mine" },
      ownerId: viewer,
    })
    const theirs = await projectsRepo.upsert(db, {
      identity: { name: "Theirs", slug: "theirs" },
      ownerId: stranger,
    })
    await seedSession(db, {
      id: "s-stranger",
      userId: stranger,
      projectId: theirs,
      updatedAt: new Date("2026-03-01T00:00:00Z"),
    })

    const rows = await rowsAs(db, viewer)

    expect(rows.map((row) => row.projectId)).toEqual([mine])
    expect(rows.every((row) => row.userId === viewer)).toBe(true)
  })

  test("S80: an org member sees the other members of an org-owned project, and nothing outside it", async () => {
    const viewer = await seedUser(db, 1003, "org-viewer")
    const colleague = await seedUser(db, 1004, "org-colleague")
    const outsider = await seedUser(db, 1005, "org-outsider")
    const [org] = await db
      .insert(orgs)
      .values({ githubOrgId: 42, githubSlug: "acme" })
      .returning({ id: orgs.id })
    if (!org) throw new Error("no seeded org")
    await db.insert(userOrgs).values([
      { userId: viewer, orgId: org.id },
      { userId: colleague, orgId: org.id },
    ])
    const { id: projectId } = await projectsRepo.upsertOwned(db, {
      identity: { name: "Acme App", slug: "acme-app" },
      owner: { kind: "org", orgId: org.id },
    })
    await projectsRepo.upsert(db, {
      identity: { name: "Outside", slug: "outside" },
      ownerId: outsider,
    })

    const rows = await rowsAs(db, viewer)

    expect(new Set(rows.map((row) => row.userId))).toEqual(new Set([viewer, colleague]))
    expect(new Set(rows.map((row) => row.projectId))).toEqual(new Set([projectId]))
  })

  test("S81: a viewer holding only a project grant sees that project's members, and no other project", async () => {
    const owner = await seedUser(db, 1006, "grant-owner")
    const grantee = await seedUser(db, 1007, "grant-viewer")
    const shared = await projectsRepo.upsert(db, {
      identity: { name: "Shared", slug: "shared" },
      ownerId: owner,
    })
    const hidden = await projectsRepo.upsert(db, {
      identity: { name: "Private", slug: "private" },
      ownerId: owner,
    })
    await projectsRepo.grant(db, grantee, shared, "viewer")

    const rows = await rowsAs(db, grantee)

    expect(new Set(rows.map((row) => row.projectId))).toEqual(new Set([shared]))
    expect(new Set(rows.map((row) => row.userId))).toEqual(new Set([owner, grantee]))
    expect(rows.some((row) => row.projectId === hidden)).toBe(false)
  })
})
