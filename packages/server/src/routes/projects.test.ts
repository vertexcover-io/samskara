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

  test("S8: no cookie and a cli-audience token are both 401 unauthorized - a cli token never reads the web API", async () => {
    const owner = await seedUser(db, 666, "guarded-owner")
    await projectsRepo.upsert(db, {
      identity: { name: "Guarded", slug: "guarded" },
      ownerId: owner,
    })
    const app = buildApp(db, env)

    const anonymous = await app.request("/api/projects")
    expect(anonymous.status).toBe(401)
    expect(await anonymous.json()).toEqual({ error: "unauthorized" })

    const cliToken = await signToken(env, { sub: owner, aud: "cli" })
    const cli = await app.request("/api/projects", {
      headers: { cookie: `session=${cliToken}` },
    })
    expect(cli.status).toBe(401)
    expect(await cli.json()).toEqual({ error: "unauthorized" })
  })
})
