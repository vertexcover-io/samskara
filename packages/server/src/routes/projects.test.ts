import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import type { CreateProjectResponse } from "@samskara/core"
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest"
import { buildApp } from "../app.js"
import { createDb, type Db } from "../db/client.js"
import {
  messages,
  orgs,
  projects,
  sessions,
  userOrgs,
  userProjectGrant,
  users,
} from "../db/schema.js"
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
  superAdminLogins: [],
  localLoginSecret: "",
  localLoginLogin: "samskara-dev",
  aiReviewModel: "zai-coding-plan/glm-5.3",
  aiReviewHarness: "opencode",
  aiReviewTimeoutMs: 600000,
}

type ProjectSummary = {
  readonly id: string
  readonly name: string
  readonly slug: string
  readonly owner: { readonly type: "user" | "org"; readonly slug: string }
  readonly sessionCount: number
  readonly lastActiveAt: string | null
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

const seedSession = (
  db: Db,
  input: { id: string; userId: string; projectId: string; title: string; updatedAt: Date },
) =>
  db.insert(sessions).values({
    id: input.id,
    source: "claude_code",
    userId: input.userId,
    projectId: input.projectId,
    title: input.title,
    updatedAt: input.updatedAt,
  })

const seedMessage = (db: Db, sessionId: string, lineNumber: number, timestamp: Date) =>
  db.insert(messages).values({
    sessionId,
    lineUuid: crypto.randomUUID(),
    subIndex: 0,
    msgType: "message",
    role: "assistant",
    timestamp,
    lineNumber,
    raw: {},
    sourceSchemaVersion: 1,
  })

const listAs = async (db: Db, userId: string): Promise<ReadonlyArray<ProjectSummary>> => {
  const token = await signToken(env, { sub: userId, aud: "web" })
  const res = await buildApp(db, env).request("/api/projects", {
    headers: { cookie: `session=${token}` },
  })
  expect(res.status).toBe(200)
  const body = (await res.json()) as { projects: ReadonlyArray<ProjectSummary> }
  return body.projects
}

describe.skipIf(!dockerAvailable())("GET /api/projects", () => {
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

  test("S5/SC7 (regression): a viewer-granted user sees the owner's project with owner reported as the granter, and an outsider sees only their own - not every project in the table", async () => {
    const ownerA = await seedUser(db, 111, "owner-a")
    const granteeB = await seedUser(db, 222, "grantee-b")
    const outsiderC = await seedUser(db, 333, "outsider-c")

    const p1 = await projectsRepo.upsert(db, {
      identity: { name: "Project One", slug: "project-one" },
      ownerId: ownerA,
    })
    const p2 = await projectsRepo.upsert(db, {
      identity: { name: "Project Two", slug: "project-two" },
      ownerId: outsiderC,
    })
    await projectsRepo.grant(db, granteeB, p1, "viewer")

    expect((await listAs(db, ownerA)).map((p) => p.id)).toEqual([p1])
    const grantedList = await listAs(db, granteeB)
    expect(grantedList.map((p) => p.id)).toEqual([p1])
    expect(grantedList[0]?.owner).toEqual({ type: "user", slug: "owner-a" })
    expect((await listAs(db, outsiderC)).map((p) => p.id)).toEqual([p2])
  })

  test("S6: a project with two sessions reports sessionCount 2 and the most recently updated session's title - not the first inserted", async () => {
    const owner = await seedUser(db, 444, "summary-owner")
    const projectId = await projectsRepo.upsert(db, {
      identity: { name: "Samskara", slug: "samskara" },
      ownerId: owner,
    })
    await seedSession(db, {
      id: "s-old",
      userId: owner,
      projectId,
      title: "Older session",
      updatedAt: new Date("2026-01-01T00:00:00Z"),
    })
    await seedSession(db, {
      id: "s-new",
      userId: owner,
      projectId,
      title: "Newer session",
      updatedAt: new Date("2026-02-01T00:00:00Z"),
    })

    const [summary] = await listAs(db, owner)

    expect(summary).toEqual({
      id: projectId,
      name: "Samskara",
      slug: "samskara",
      owner: { type: "user", slug: "summary-owner" },
      sessionCount: 2,
      lastActiveAt: new Date("2026-02-01T00:00:00Z").toISOString(),
    })
  })

  test("S7: a project with no sessions reports sessionCount 0 with null activity - not a null count or a dropped row", async () => {
    const owner = await seedUser(db, 555, "empty-owner")
    const projectId = await projectsRepo.upsert(db, {
      identity: { name: "Empty", slug: "empty" },
      ownerId: owner,
    })

    const [summary] = await listAs(db, owner)

    expect(summary).toEqual({
      id: projectId,
      name: "Empty",
      slug: "empty",
      owner: { type: "user", slug: "empty-owner" },
      sessionCount: 0,
      lastActiveAt: null,
    })
  })

  test("SA5: a project's activity follows its sessions' messages, not when their rows were last touched", async () => {
    const owner = await seedUser(db, 4444, "project-activity-owner")
    const projectId = await projectsRepo.upsert(db, {
      identity: { name: "Active", slug: "active" },
      ownerId: owner,
    })
    await seedSession(db, {
      id: "touched-late",
      userId: owner,
      projectId,
      title: "Touched late",
      updatedAt: new Date("2026-05-01T00:00:00Z"),
    })
    await seedMessage(db, "touched-late", 1, new Date("2026-03-01T00:00:00Z"))

    const [summary] = await listAs(db, owner)

    expect(summary?.lastActiveAt).toBe(new Date("2026-03-01T00:00:00Z").toISOString())
  })

  test("SC3: a personal project reports its owner as the user", async () => {
    const owner = await seedUser(db, 700, "sc3-owner")
    await projectsRepo.upsert(db, {
      identity: { name: "Solo", slug: "solo" },
      ownerId: owner,
    })

    const [summary] = await listAs(db, owner)
    expect(summary?.owner).toEqual({ type: "user", slug: "sc3-owner" })
  })

  test("SC1: a member of the owning org lists the org's project with its owner, and a non-member does not", async () => {
    const member = await seedUser(db, 701, "sc1-member")
    const outsider = await seedUser(db, 702, "sc1-outsider")
    const [org] = await db
      .insert(orgs)
      .values({ githubSlug: "acme", name: "Acme" })
      .returning({ id: orgs.id, githubSlug: orgs.githubSlug })
    if (!org) throw new Error("seed org failed")
    await db.insert(userOrgs).values({ userId: member, orgId: org.id })

    const { id: projectId } = await projectsRepo.upsertOwned(db, {
      identity: { name: "acme-widget", slug: "acme-widget" },
      owner: { kind: "org", orgId: org.id },
    })

    const memberList = await listAs(db, member)
    expect(memberList.map((p) => p.id)).toContain(projectId)
    expect(memberList.find((p) => p.id === projectId)?.owner).toEqual({
      type: "org",
      slug: "acme",
    })
    expect((await listAs(db, outsider)).map((p) => p.id)).not.toContain(projectId)
  })

  test("S8 (revised): no cookie is 401 - the cli-audience case moved to the reassign block, which asserts the body too", async () => {
    const owner = await seedUser(db, 666, "guarded-owner")
    await projectsRepo.upsert(db, {
      identity: { name: "Guarded", slug: "guarded" },
      ownerId: owner,
    })
    const app = buildApp(db, env)

    const anonymous = await app.request("/api/projects")
    expect(anonymous.status).toBe(401)
    expect(await anonymous.json()).toEqual({ error: "unauthorized" })
  })
})

describe.skipIf(!dockerAvailable())("GET /api/projects/resolve", () => {
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

  test("TR-3: a cli token resolves its accessible projects as id/name/slug - and a stranger's project stays hidden", async () => {
    const owner = await seedUser(db, 901, "resolve-owner")
    const stranger = await seedUser(db, 902, "resolve-stranger")
    const mine = await projectsRepo.upsert(db, {
      identity: { name: "Samskara Web", slug: "samskara-web" },
      ownerId: owner,
    })
    await projectsRepo.upsert(db, {
      identity: { name: "Stranger Thing", slug: "stranger-thing" },
      ownerId: stranger,
    })

    const token = await signToken(env, { sub: owner, aud: "cli" })
    const res = await buildApp(db, env).request("/api/projects/resolve", {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { projects: ReadonlyArray<Record<string, unknown>> }
    expect(body.projects).toEqual([{ id: mine, name: "Samskara Web", slug: "samskara-web" }])
  })

  test("TR-3: web tokens and anonymous callers are refused - resolve is the CLI's endpoint", async () => {
    const owner = await seedUser(db, 903, "resolve-guarded")
    await projectsRepo.upsert(db, {
      identity: { name: "Guarded", slug: "resolve-guarded" },
      ownerId: owner,
    })
    const app = buildApp(db, env)

    const anonymous = await app.request("/api/projects/resolve")
    expect(anonymous.status).toBe(401)

    const webToken = await signToken(env, { sub: owner, aud: "web" })
    const withWeb = await app.request("/api/projects/resolve", {
      headers: { authorization: `Bearer ${webToken}` },
    })
    expect(withWeb.status).toBe(401)
    expect(await withWeb.json()).toEqual({ error: "unauthorized" })
  })
})

describe.skipIf(!dockerAvailable())("POST /api/projects", () => {
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

  const seedOrg = async (slug: string): Promise<string> => {
    const [org] = await db.insert(orgs).values({ githubSlug: slug, name: slug }).returning({
      id: orgs.id,
    })
    if (!org) throw new Error("seed org failed")
    return org.id
  }

  const postAs = async (
    userId: string,
    body: unknown,
  ): Promise<{ status: number; body: CreateProjectResponse }> => {
    const token = await signToken(env, { sub: userId, aud: "cli" })
    const res = await buildApp(db, env).request("/api/projects", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    })
    return { status: res.status, body: (await res.json()) as CreateProjectResponse }
  }

  test("SC18: a member's first POST creates the org project and the second returns it", async () => {
    const member = await seedUser(db, 801, "sc18-member")
    const orgId = await seedOrg("acme")
    await db.insert(userOrgs).values({ userId: member, orgId })
    const body = {
      name: "widget",
      slug: "acme-widget",
      remote: { host: "github.com", owner: "Acme", repoName: "widget" },
    }

    const first = await postAs(member, body)
    expect(first.status).toBe(201)
    expect(first.body.owner).toEqual({ type: "org", slug: "acme" })
    expect(first.body.reason).toBeUndefined()

    const second = await postAs(member, body)
    expect(second.status).toBe(200)
    expect(second.body.id).toBe(first.body.id)

    const rows = await db.select().from(projects).where(eq(projects.slug, "acme-widget"))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ ownerOrgId: orgId, ownerUserId: null })
  })

  test("R11: two POSTs for the same org repo with different remote casing yield one project", async () => {
    const member = await seedUser(db, 805, "sc-casing-member")
    const orgId = await seedOrg("acme")
    await db.insert(userOrgs).values({ userId: member, orgId })

    const first = await postAs(member, {
      name: "widget",
      slug: "client-slug-one",
      remote: { host: "github.com", owner: "Acme", repoName: "Widget" },
    })
    expect(first.status).toBe(201)
    expect(first.body.owner).toEqual({ type: "org", slug: "acme" })

    const second = await postAs(member, {
      name: "widget",
      slug: "client-slug-two",
      remote: { host: "github.com", owner: "acme", repoName: "widget" },
    })
    expect(second.status).toBe(200)
    expect(second.body.id).toBe(first.body.id)

    const rows = await db.select().from(projects).where(eq(projects.ownerOrgId, orgId))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.slug).toBe("acme-widget")
  })

  test("SC19: a non-member's POST creates a personal project and says why", async () => {
    const outsider = await seedUser(db, 802, "sc19-outsider")
    await seedOrg("acme")
    const body = {
      name: "widget",
      slug: "acme-widget-2",
      remote: { host: "github.com", owner: "acme", repoName: "widget" },
    }

    const res = await postAs(outsider, body)
    expect(res.status).toBe(201)
    expect(res.body.owner).toEqual({ type: "user", slug: "sc19-outsider" })
    expect(res.body.reason).toBe("notMember")

    const [row] = await db.select().from(projects).where(eq(projects.slug, "acme-widget-2"))
    expect(row).toMatchObject({ ownerUserId: outsider, ownerOrgId: null })
  })

  test("SC22: a super admin's POST is org-owned even without a membership row", async () => {
    const admin = await seedUser(db, 806, "sc22-admin")
    await db.update(users).set({ isSuperAdmin: true }).where(eq(users.id, admin))
    const orgId = await seedOrg("acme")

    const res = await postAs(admin, {
      name: "widget",
      slug: "acme-widget",
      remote: { host: "github.com", owner: "acme", repoName: "widget" },
    })
    expect(res.status).toBe(201)
    expect(res.body.owner).toEqual({ type: "org", slug: "acme" })
    expect(res.body.reason).toBeUndefined()

    const [row] = await db.select().from(projects).where(eq(projects.slug, "acme-widget"))
    expect(row).toMatchObject({ ownerOrgId: orgId, ownerUserId: null })
  })

  test("SC23: a super admin's POST for an unregistered org stays personal", async () => {
    const admin = await seedUser(db, 807, "sc23-admin")
    await db.update(users).set({ isSuperAdmin: true }).where(eq(users.id, admin))

    const res = await postAs(admin, {
      name: "widget",
      slug: "nosuchorg-widget",
      remote: { host: "github.com", owner: "nosuchorg", repoName: "widget" },
    })
    expect(res.status).toBe(201)
    expect(res.body.owner).toEqual({ type: "user", slug: "sc23-admin" })
    expect(res.body.reason).toBeUndefined()
  })

  test("SC20: a repo with no remote or a non-GitHub host is personal", async () => {
    const caller = await seedUser(db, 803, "sc20-caller")
    await seedOrg("acme")

    const noRemote = await postAs(caller, { name: "solo", slug: "sc20-solo" })
    expect(noRemote.status).toBe(201)
    expect(noRemote.body.owner.type).toBe("user")
    expect(noRemote.body.reason).toBeUndefined()

    const nonGithub = await postAs(caller, {
      name: "gitlab-widget",
      slug: "sc20-gitlab-widget",
      remote: { host: "gitlab.com", owner: "acme", repoName: "widget" },
    })
    expect(nonGithub.status).toBe(201)
    expect(nonGithub.body.owner.type).toBe("user")
    expect(nonGithub.body.reason).toBeUndefined()
  })

  test("SC21: the route needs a CLI token", async () => {
    const caller = await seedUser(db, 804, "sc21-caller")
    const webToken = await signToken(env, { sub: caller, aud: "web" })
    const app = buildApp(db, env)
    const body = { name: "x", slug: "sc21-x" }

    const withWebCookie = await app.request("/api/projects", {
      method: "POST",
      headers: { cookie: `session=${webToken}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    })
    expect(withWebCookie.status).toBe(401)

    const withNothing = await app.request("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
    expect(withNothing.status).toBe(401)
  })
})

type ReassignBody = { readonly fromProjectId: string; readonly scope?: "mine" | "all" }

const reassignAs = async (
  db: Db,
  userId: string,
  toProjectId: string,
  body: ReassignBody,
): Promise<{ status: number; json: Record<string, unknown> }> => {
  const token = await signToken(env, { sub: userId, aud: "cli" })
  const res = await buildApp(db, env).request(`/api/projects/${toProjectId}/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
  return { status: res.status, json: (await res.json()) as Record<string, unknown> }
}

const projectOf = async (db: Db, sessionId: string): Promise<string | undefined> => {
  const [row] = await db
    .select({ projectId: sessions.projectId })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
  return row?.projectId
}

describe.skipIf(!dockerAvailable())("POST /api/projects/:id/sessions", () => {
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

  const seedPair = async (githubId: number, login: string) => {
    const userId = await seedUser(db, githubId, login)
    const from = await projectsRepo.upsert(db, {
      identity: { name: "From", slug: `from-${login}` },
      ownerId: userId,
    })
    const to = await projectsRepo.upsert(db, {
      identity: { name: "To", slug: `to-${login}` },
      ownerId: userId,
    })
    return { userId, from, to }
  }

  test("the caller's own sessions land in the destination project and the count says how many moved", async () => {
    const { userId, from, to } = await seedPair(1001, "mover")
    for (const id of ["s-1", "s-2"]) {
      await seedSession(db, { id, userId, projectId: from, title: id, updatedAt: new Date() })
    }

    const { status, json } = await reassignAs(db, userId, to, { fromProjectId: from })

    expect(status).toBe(200)
    expect(json).toEqual({ moved: 2 })
    expect(await projectOf(db, "s-1")).toBe(to)
    expect(await projectOf(db, "s-2")).toBe(to)
  })

  test("the default scope leaves a teammate's sessions in the source project - relocating a folder must not move history that is not yours", async () => {
    const org = await db
      .insert(orgs)
      .values({ githubSlug: "acme" })
      .returning({ id: orgs.id })
      .then(([row]) => row?.id ?? "")
    const mine = await seedUser(db, 1002, "mine")
    const theirs = await seedUser(db, 1003, "theirs")
    await db.insert(userOrgs).values([
      { orgId: org, userId: mine },
      { orgId: org, userId: theirs },
    ])
    const from = await projectsRepo.upsertOwned(db, {
      identity: { name: "Shared", slug: "acme-shared" },
      owner: { kind: "org", orgId: org },
    })
    const to = await projectsRepo.upsert(db, {
      identity: { name: "Personal", slug: "personal" },
      ownerId: mine,
    })
    await seedSession(db, {
      id: "s-mine",
      userId: mine,
      projectId: from.id,
      title: "mine",
      updatedAt: new Date(),
    })
    await seedSession(db, {
      id: "s-theirs",
      userId: theirs,
      projectId: from.id,
      title: "theirs",
      updatedAt: new Date(),
    })

    const { status, json } = await reassignAs(db, mine, to, { fromProjectId: from.id })

    expect(status).toBe(200)
    expect(json).toEqual({ moved: 1 })
    expect(await projectOf(db, "s-mine")).toBe(to)
    expect(await projectOf(db, "s-theirs")).toBe(from.id)
  })

  test("scope 'all' moves a teammate's sessions only for a super admin - project admin on the source does not bound who reads the destination", async () => {
    const org = await db
      .insert(orgs)
      .values({ githubSlug: "beta" })
      .returning({ id: orgs.id })
      .then(([row]) => row?.id ?? "")
    const member = await seedUser(db, 1004, "member")
    const other = await seedUser(db, 1005, "other")
    await db.insert(userOrgs).values([
      { orgId: org, userId: member },
      { orgId: org, userId: other },
    ])
    const from = await projectsRepo.upsertOwned(db, {
      identity: { name: "Shared", slug: "beta-shared" },
      owner: { kind: "org", orgId: org },
    })
    const to = await projectsRepo.upsert(db, {
      identity: { name: "Landing", slug: "landing" },
      ownerId: member,
    })
    await seedSession(db, {
      id: "s-other",
      userId: other,
      projectId: from.id,
      title: "other",
      updatedAt: new Date(),
    })

    // Admin on the source is deliberately not enough: it says nothing about who can read the
    // destination, and moving a row is what grants its readers access.
    const denied = await reassignAs(db, member, to, { fromProjectId: from.id, scope: "all" })
    expect(denied.status).toBe(403)
    expect(denied.json).toEqual({ error: "superAdminRequired" })
    expect(await projectOf(db, "s-other")).toBe(from.id)

    await projectsRepo.grant(db, member, from.id, "admin")
    const stillDenied = await reassignAs(db, member, to, { fromProjectId: from.id, scope: "all" })
    expect(stillDenied.status).toBe(403)
    expect(stillDenied.json).toEqual({ error: "superAdminRequired" })
    expect(await projectOf(db, "s-other")).toBe(from.id)

    await db.update(users).set({ isSuperAdmin: true }).where(eq(users.id, member))
    const allowed = await reassignAs(db, member, to, { fromProjectId: from.id, scope: "all" })
    expect(allowed.status).toBe(200)
    expect(allowed.json).toEqual({ moved: 1 })
    expect(await projectOf(db, "s-other")).toBe(to)
  })

  test("a destination the caller cannot write is refused without moving anything, and says nothing about whether it exists", async () => {
    const { userId, from } = await seedPair(1006, "outsider")
    const strangerId = await seedUser(db, 1007, "stranger")
    const strangersProject = await projectsRepo.upsert(db, {
      identity: { name: "Private", slug: "private" },
      ownerId: strangerId,
    })
    await seedSession(db, {
      id: "s-stay",
      userId,
      projectId: from,
      title: "stay",
      updatedAt: new Date(),
    })

    const real = await reassignAs(db, userId, strangersProject, { fromProjectId: from })
    expect(real.status).toBe(403)
    expect(real.json).toEqual({ error: "destinationForbidden" })

    const imaginary = await reassignAs(db, userId, crypto.randomUUID(), { fromProjectId: from })
    expect(imaginary.status).toBe(403)
    expect(imaginary.json).toEqual(real.json)

    expect(await projectOf(db, "s-stay")).toBe(from)
  })

  test("a source the caller cannot see moves nothing but is not refused - the userId filter is what stops a sweep, and refusing would strand a folder pinned to a project it has lost", async () => {
    const { userId, to } = await seedPair(1008, "sweeper")
    const victimId = await seedUser(db, 1009, "victim")
    const victimProject = await projectsRepo.upsert(db, {
      identity: { name: "Victim", slug: "victim" },
      ownerId: victimId,
    })
    await seedSession(db, {
      id: "s-victim",
      userId: victimId,
      projectId: victimProject,
      title: "victim",
      updatedAt: new Date(),
    })

    const { status, json } = await reassignAs(db, userId, to, { fromProjectId: victimProject })

    expect(status).toBe(200)
    expect(json).toEqual({ moved: 0 })
    expect(await projectOf(db, "s-victim")).toBe(victimProject)
  })

  test("a caller pulls their own sessions out of a project they can no longer read, leaving everyone else's behind", async () => {
    const { userId, to } = await seedPair(1012, "stranded")
    const strangerId = await seedUser(db, 1013, "keeps-it")
    const lost = await projectsRepo.upsert(db, {
      identity: { name: "Lost", slug: "lost" },
      ownerId: strangerId,
    })
    await seedSession(db, {
      id: "s-stranded",
      userId,
      projectId: lost,
      title: "mine",
      updatedAt: new Date(),
    })
    await seedSession(db, {
      id: "s-not-mine",
      userId: strangerId,
      projectId: lost,
      title: "theirs",
      updatedAt: new Date(),
    })

    const { status, json } = await reassignAs(db, userId, to, { fromProjectId: lost })

    expect(status).toBe(200)
    expect(json).toEqual({ moved: 1 })
    expect(await projectOf(db, "s-stranded")).toBe(to)
    expect(await projectOf(db, "s-not-mine")).toBe(lost)
  })

  test("the endpoint refuses an unauthenticated caller, so nothing can bulk-rewrite projectId without a token", async () => {
    const { userId, from, to } = await seedPair(1014, "anon")
    await seedSession(db, {
      id: "s-anon",
      userId,
      projectId: from,
      title: "anon",
      updatedAt: new Date(),
    })

    const res = await buildApp(db, env).request(`/api/projects/${to}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fromProjectId: from }),
    })

    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: "unauthorized" })
    expect(await projectOf(db, "s-anon")).toBe(from)
  })

  test("a destination id that is not a uuid is refused like any other, rather than reaching Postgres and surfacing as a 500", async () => {
    const { userId, from } = await seedPair(1015, "malformed")
    await seedSession(db, {
      id: "s-malformed",
      userId,
      projectId: from,
      title: "malformed",
      updatedAt: new Date(),
    })

    const { status, json } = await reassignAs(db, userId, "not-a-uuid", { fromProjectId: from })

    expect(status).toBe(403)
    expect(json).toEqual({ error: "destinationForbidden" })
    expect(await projectOf(db, "s-malformed")).toBe(from)
  })

  test("reassigning a project onto itself moves nothing and still succeeds, so re-running a landed reassign is safe", async () => {
    const { userId, from } = await seedPair(1010, "idempotent")
    await seedSession(db, {
      id: "s-same",
      userId,
      projectId: from,
      title: "same",
      updatedAt: new Date(),
    })

    const { status, json } = await reassignAs(db, userId, from, { fromProjectId: from })

    expect(status).toBe(200)
    expect(json).toEqual({ moved: 0 })
    expect(await projectOf(db, "s-same")).toBe(from)
  })

  test("S8 (moved): a cli token may list projects, since the reassign picker has to show the caller where sessions can go", async () => {
    const { userId, from } = await seedPair(1011, "lister")
    const token = await signToken(env, { sub: userId, aud: "cli" })
    const res = await buildApp(db, env).request("/api/projects", {
      headers: { authorization: `Bearer ${token}` },
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as { projects: ReadonlyArray<ProjectSummary> }
    expect(body.projects.some((p) => p.id === from)).toBe(true)
  })
})
