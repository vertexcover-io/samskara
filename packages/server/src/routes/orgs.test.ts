import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest"
import { buildApp } from "../app.js"
import { createDb, type Db } from "../db/client.js"
import { orgs, projects, sessions, userOrgs, userProjectGrant, users } from "../db/schema.js"
import type { Env } from "../lib/env.js"
import { signToken } from "../lib/jwt.js"
import { upsertBySlug } from "../repositories/orgs.repo.js"
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
  superAdminLogins: [],
}

type OrgDetailBody = {
  readonly id: string
  readonly githubSlug: string
  readonly name: string
  readonly autoAddMembers: boolean
  readonly members: ReadonlyArray<{
    readonly id: string
    readonly githubLogin: string
    readonly avatarUrl: string | null
  }>
  readonly projects: ReadonlyArray<{
    readonly id: string
    readonly name: string
    readonly slug: string
    readonly sessionCount: number
  }>
  readonly sessionCount: number
}

const seedUser = (db: Db, githubId: number, login: string): Promise<string> =>
  db
    .insert(users)
    .values({ githubId, githubLogin: login })
    .returning({ id: users.id })
    .then(([row]) => {
      if (!row) throw new Error("no seeded user")
      return row.id
    })

const seedOrgRow = async (
  db: Db,
  slug: string,
  flags: { readonly name?: string | null; readonly autoAddMembers?: boolean } = {},
): Promise<string> => {
  const [org] = await db
    .insert(orgs)
    .values({
      githubSlug: slug,
      name: flags.name ?? slug,
      autoAddMembers: flags.autoAddMembers ?? false,
    })
    .returning({ id: orgs.id })
  if (!org) throw new Error("seed org failed")
  return org.id
}

const seedSession = (
  db: Db,
  input: { id: string; userId: string; projectId: string; title: string },
) =>
  db.insert(sessions).values({
    id: input.id,
    source: "claude_code",
    userId: input.userId,
    projectId: input.projectId,
    title: input.title,
  })

const getAs = async (
  db: Db,
  userId: string,
  slug: string,
): Promise<{ status: number; body: unknown }> => {
  const token = await signToken(env, { sub: userId, aud: "web" })
  const res = await buildApp(db, env).request(`/api/orgs/${slug}`, {
    headers: { cookie: `session=${token}` },
  })
  return { status: res.status, body: await res.json() }
}

const patchAs = async (
  db: Db,
  userId: string,
  slug: string,
  json: unknown,
): Promise<{ status: number; body: unknown }> => {
  const token = await signToken(env, { sub: userId, aud: "web" })
  const res = await buildApp(db, env).request(`/api/orgs/${slug}`, {
    method: "PATCH",
    headers: { cookie: `session=${token}`, "content-type": "application/json" },
    body: JSON.stringify(json),
  })
  return { status: res.status, body: await res.json() }
}

const storedFlags = async (
  db: Db,
  orgId: string,
): Promise<{ readonly autoAddMembers: boolean; readonly name: string | null }> => {
  const [row] = await db
    .select({ autoAddMembers: orgs.autoAddMembers, name: orgs.name })
    .from(orgs)
    .where(eq(orgs.id, orgId))
  if (!row) throw new Error("org row vanished")
  return row
}

const postAs = async (
  db: Db,
  userId: string,
  json: unknown,
): Promise<{ status: number; body: unknown }> => {
  const token = await signToken(env, { sub: userId, aud: "web" })
  const res = await buildApp(db, env).request("/api/orgs", {
    method: "POST",
    headers: { cookie: `session=${token}`, "content-type": "application/json" },
    body: JSON.stringify(json),
  })
  return { status: res.status, body: await res.json() }
}

const getListAs = async (db: Db, userId: string): Promise<{ status: number; body: unknown }> => {
  const token = await signToken(env, { sub: userId, aud: "web" })
  const res = await buildApp(db, env).request("/api/orgs", {
    headers: { cookie: `session=${token}` },
  })
  return { status: res.status, body: await res.json() }
}

const makeSuperAdmin = (db: Db, userId: string) =>
  db.update(users).set({ isSuperAdmin: true }).where(eq(users.id, userId))

describe.skipIf(!dockerAvailable())("GET /api/orgs/:slug", () => {
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
    await db.delete(projects)
    await db.delete(userOrgs)
    await db.delete(orgs)
    await db.delete(users)
  })

  test("SC20: a member reads their org with its members and projects", async () => {
    const member = await seedUser(db, 1100, "sc20-member")
    const other = await seedUser(db, 1101, "sc20-other")
    const orgId = await seedOrgRow(db, "sc20-org")
    await db.insert(userOrgs).values([
      { userId: member, orgId },
      { userId: other, orgId },
    ])
    const { id: projectId } = await projectsRepo.upsertOwned(db, {
      identity: { name: "sc20-project", slug: "sc20-project" },
      owner: { kind: "org", orgId },
    })
    await seedSession(db, { id: "sc20-s1", userId: member, projectId, title: "s1" })
    await seedSession(db, { id: "sc20-s2", userId: member, projectId, title: "s2" })
    await seedSession(db, { id: "sc20-s3", userId: member, projectId, title: "s3" })

    const { status, body } = await getAs(db, member, "sc20-org")

    expect(status).toBe(200)
    const org = (body as { org: OrgDetailBody }).org
    expect(org.members.map((m) => m.githubLogin).sort()).toEqual(["sc20-member", "sc20-other"])
    expect(org.projects).toEqual([
      { id: projectId, name: "sc20-project", slug: "sc20-project", sessionCount: 3 },
    ])
    expect(org.sessionCount).toBe(3)
  })

  test("SC21: an org the caller does not belong to is reported as missing", async () => {
    const stranger = await seedUser(db, 1102, "sc21-stranger")
    await seedOrgRow(db, "sc21-org")

    const { status, body } = await getAs(db, stranger, "sc21-org")

    expect(status).toBe(404)
    expect(body).toEqual({ error: "orgNotFound" })
  })

  test("SC22: a super admin reads an org they do not belong to", async () => {
    const admin = await seedUser(db, 1103, "sc22-admin")
    await db.update(users).set({ isSuperAdmin: true }).where(eq(users.id, admin))
    const orgId = await seedOrgRow(db, "sc22-org")
    const member = await seedUser(db, 1104, "sc22-member")
    await db.insert(userOrgs).values({ userId: member, orgId })

    const { status, body } = await getAs(db, admin, "sc22-org")

    expect(status).toBe(200)
    const org = (body as { org: OrgDetailBody }).org
    expect(org.members.map((m) => m.githubLogin)).toEqual(["sc22-member"])
  })

  test("SC41: an org that was never named reports its slug as its name", async () => {
    const member = await seedUser(db, 1105, "sc41-member")
    const orgId = await seedOrgRow(db, "sc41-org", { name: null })
    await db.insert(userOrgs).values({ userId: member, orgId })

    const { status, body } = await getAs(db, member, "sc41-org")

    expect(status).toBe(200)
    expect((body as { org: OrgDetailBody }).org.name).toBe("sc41-org")
  })

  test("SC23: an org slug matches whatever the case", async () => {
    const member = await seedUser(db, 1106, "sc23-member")
    const orgId = await seedOrgRow(db, "vertexcover-io")
    await db.insert(userOrgs).values({ userId: member, orgId })

    const { status, body } = await getAs(db, member, "Vertexcover-IO")

    expect(status).toBe(200)
    expect((body as { org: OrgDetailBody }).org.id).toBe(orgId)
  })
})

describe.skipIf(!dockerAvailable())("PATCH /api/orgs/:slug", () => {
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
    await db.delete(projects)
    await db.delete(userOrgs)
    await db.delete(orgs)
    await db.delete(users)
  })

  test("SC28: a member turns auto-add on and it sticks", async () => {
    const member = await seedUser(db, 1200, "sc28-member")
    const orgId = await seedOrgRow(db, "sc28-org", { autoAddMembers: false })
    await db.insert(userOrgs).values({ userId: member, orgId })

    const { status, body } = await patchAs(db, member, "sc28-org", { autoAddMembers: true })

    expect(status).toBe(200)
    expect((body as { org: OrgDetailBody }).org.autoAddMembers).toBe(true)

    const read = await getAs(db, member, "sc28-org")
    expect((read.body as { org: OrgDetailBody }).org.autoAddMembers).toBe(true)
  })

  test("SC29: a stranger cannot change another org's settings", async () => {
    const stranger = await seedUser(db, 1201, "sc29-stranger")
    const orgId = await seedOrgRow(db, "sc29-org", { autoAddMembers: false })

    const { status, body } = await patchAs(db, stranger, "sc29-org", { autoAddMembers: true })

    expect(status).toBe(404)
    expect(body).toEqual({ error: "orgNotFound" })
    expect((await storedFlags(db, orgId)).autoAddMembers).toBe(false)
  })

  test("SC30: a body that is not a boolean is rejected", async () => {
    const member = await seedUser(db, 1202, "sc30-member")
    const orgId = await seedOrgRow(db, "sc30-org", { autoAddMembers: false })
    await db.insert(userOrgs).values({ userId: member, orgId })

    const { status } = await patchAs(db, member, "sc30-org", { autoAddMembers: "yes" })

    expect(status).toBe(400)
    expect((await storedFlags(db, orgId)).autoAddMembers).toBe(false)
  })

  test("SC42: a member renames the org and the change sticks", async () => {
    const member = await seedUser(db, 1203, "sc42-member")
    const orgId = await seedOrgRow(db, "sc42-org", { name: null, autoAddMembers: true })
    await db.insert(userOrgs).values({ userId: member, orgId })

    const { status, body } = await patchAs(db, member, "sc42-org", { name: "Vertexcover" })

    expect(status).toBe(200)
    const patched = (body as { org: OrgDetailBody }).org
    expect(patched.name).toBe("Vertexcover")
    expect(patched.autoAddMembers).toBe(true)

    const read = await getAs(db, member, "sc42-org")
    expect((read.body as { org: OrgDetailBody }).org.name).toBe("Vertexcover")
  })

  test("SC43: clearing the name puts the slug back", async () => {
    const member = await seedUser(db, 1204, "sc43-member")
    const orgId = await seedOrgRow(db, "vertexcover-io", { name: "Vertexcover" })
    await db.insert(userOrgs).values({ userId: member, orgId })

    const { status, body } = await patchAs(db, member, "vertexcover-io", { name: null })

    expect(status).toBe(200)
    expect((body as { org: OrgDetailBody }).org.name).toBe("vertexcover-io")

    const read = await getAs(db, member, "vertexcover-io")
    expect((read.body as { org: OrgDetailBody }).org.name).toBe("vertexcover-io")
  })

  test("SC45: a body asking for no change is rejected", async () => {
    const member = await seedUser(db, 1205, "sc45-member")
    const orgId = await seedOrgRow(db, "sc45-org", { autoAddMembers: false, name: "Keep" })
    await db.insert(userOrgs).values({ userId: member, orgId })

    const { status } = await patchAs(db, member, "sc45-org", {})

    expect(status).toBe(400)
    expect(await storedFlags(db, orgId)).toEqual({ autoAddMembers: false, name: "Keep" })
  })
})

describe.skipIf(!dockerAvailable())("POST /api/orgs", () => {
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
    await db.delete(projects)
    await db.delete(userOrgs)
    await db.delete(orgs)
    await db.delete(users)
  })

  test("SC34: a super admin registers an org and it becomes readable", async () => {
    const admin = await seedUser(db, 1400, "sc34-admin")
    await makeSuperAdmin(db, admin)

    const { status, body } = await postAs(db, admin, { githubSlug: "sc34-acme" })

    expect(status).toBe(201)
    const [stored] = await db.select().from(orgs).where(eq(orgs.githubSlug, "sc34-acme"))
    expect(body).toEqual({
      org: { id: stored?.id, githubSlug: "sc34-acme", name: "sc34-acme" },
    })

    const read = await getAs(db, admin, "sc34-acme")
    expect(read.status).toBe(200)
  })

  test("SC35: an ordinary user cannot register an org", async () => {
    const stranger = await seedUser(db, 1401, "sc35-stranger")

    const { status, body } = await postAs(db, stranger, { githubSlug: "sc35-acme" })

    expect(status).toBe(403)
    expect(body).toEqual({ error: "forbidden" })
    expect(await db.select().from(orgs).where(eq(orgs.githubSlug, "sc35-acme"))).toHaveLength(0)
  })

  test("SC36: registering an org that already exists leaves its auto-add setting alone", async () => {
    const admin = await seedUser(db, 1402, "sc36-admin")
    await makeSuperAdmin(db, admin)
    await postAs(db, admin, { githubSlug: "sc36-acme", autoAddMembers: true })

    // The opposite flag, so a route that wrote it on conflict would flip the stored value.
    const { status, body } = await postAs(db, admin, {
      githubSlug: "sc36-acme",
      autoAddMembers: false,
    })

    expect(status).toBe(200)
    const rows = await db.select().from(orgs).where(eq(orgs.githubSlug, "sc36-acme"))
    expect(body).toEqual({
      org: { id: rows[0]?.id, githubSlug: "sc36-acme", name: "sc36-acme" },
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.autoAddMembers).toBe(true)
  })

  test("SC54: seed:org still writes the flag on an org that already exists", async () => {
    await seedOrgRow(db, "sc54-acme", { autoAddMembers: true })

    await upsertBySlug(db, "sc54-acme", { autoAddMembers: false })

    const rows = await db.select().from(orgs).where(eq(orgs.githubSlug, "sc54-acme"))
    // The script's flag is the operator's stated intent, so it overwrites where the route does not.
    expect(rows[0]?.autoAddMembers).toBe(false)
  })

  test("SC46: an omitted auto-add flag registers the org with it on", async () => {
    const admin = await seedUser(db, 1403, "sc46-admin")
    await makeSuperAdmin(db, admin)

    const { status, body } = await postAs(db, admin, { githubSlug: "sc46-acme" })

    expect(status).toBe(201)
    const rows = await db.select().from(orgs).where(eq(orgs.githubSlug, "sc46-acme"))
    expect(body).toEqual({
      org: { id: rows[0]?.id, githubSlug: "sc46-acme", name: "sc46-acme" },
    })
    expect(rows[0]?.autoAddMembers).toBe(true)
  })

  test("SC37: two spellings of one slug register one org", async () => {
    const admin = await seedUser(db, 1404, "sc37-admin")
    await makeSuperAdmin(db, admin)

    const first = await postAs(db, admin, { githubSlug: "Sc37Acme" })
    const second = await postAs(db, admin, { githubSlug: "sc37acme" })

    expect(first.status).toBe(201)
    expect(second.status).toBe(200)
    expect(await db.select().from(orgs).where(eq(orgs.githubSlug, "sc37acme"))).toHaveLength(1)
  })

  test("SC38: a slug GitHub would not allow is rejected", async () => {
    const admin = await seedUser(db, 1405, "sc38-admin")
    await makeSuperAdmin(db, admin)

    const { status } = await postAs(db, admin, { githubSlug: "not a slug" })

    expect(status).toBe(400)
    expect(await db.select().from(orgs).where(eq(orgs.githubSlug, "not a slug"))).toHaveLength(0)
  })
})

describe.skipIf(!dockerAvailable())("GET /api/orgs", () => {
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
    await db.delete(projects)
    await db.delete(userOrgs)
    await db.delete(orgs)
    await db.delete(users)
  })

  test("SC39: the list holds only the caller's orgs", async () => {
    const member = await seedUser(db, 1500, "sc39-member")
    const orgId = await seedOrgRow(db, "sc39-org")
    await db.insert(userOrgs).values({ userId: member, orgId })
    await seedOrgRow(db, "sc39-other-org")

    const { status, body } = await getListAs(db, member)

    expect(status).toBe(200)
    expect(
      (body as { orgs: ReadonlyArray<{ githubSlug: string }> }).orgs.map((org) => org.githubSlug),
    ).toEqual(["sc39-org"])
  })

  test("SC47: the list holds every registered org for a super admin", async () => {
    const admin = await seedUser(db, 1501, "sc47-admin")
    await makeSuperAdmin(db, admin)
    await seedOrgRow(db, "sc47-alpha")
    await seedOrgRow(db, "sc47-beta")

    const { status, body } = await getListAs(db, admin)

    expect(status).toBe(200)
    // A super admin belongs to neither org, so membership alone would return an empty list.
    expect(
      (body as { orgs: ReadonlyArray<{ githubSlug: string }> }).orgs.map((org) => org.githubSlug),
    ).toEqual(["sc47-alpha", "sc47-beta"])
  })

  test("SC48: an org with no name of its own is listed by its slug", async () => {
    const member = await seedUser(db, 1502, "sc48-member")
    const orgId = await seedOrgRow(db, "sc48-org")
    await db.insert(userOrgs).values({ userId: member, orgId })

    const { status, body } = await getListAs(db, member)

    expect(status).toBe(200)
    expect((body as { orgs: ReadonlyArray<{ name: string }> }).orgs[0]?.name).toBe("sc48-org")
  })
})
