import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest"
import { buildApp } from "../app.js"
import { createDb, type Db } from "../db/client.js"
import {
  artifact,
  commits,
  messages,
  orgs,
  projects,
  pullRequests,
  sessionPullRequests,
  sessions,
  subagents,
  tokenUsage,
  toolCall,
  toolResult,
  userOrgs,
  userProjectGrant,
  users,
} from "../db/schema.js"
import type { Env } from "../lib/env.js"
import { signToken } from "../lib/jwt.js"
import * as projectsRepo from "../repositories/projects.repo.js"
import * as reposRepo from "../repositories/repos.repo.js"

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

type SessionRepo = {
  readonly host: string
  readonly owner: string
  readonly repoName: string
}

type SessionSummary = {
  readonly id: string
  readonly title: string | null
  readonly projectId: string
  readonly projectName: string
  readonly projectSlug: string
  readonly userLogin: string
  readonly repo: SessionRepo | null
  readonly durationMs: number | null
  readonly tokensTotal: number
  readonly status: string
  readonly lastActiveAt: string
}

const seedUser = (db: Db, githubId: number, login: string, isSuperAdmin = false): Promise<string> =>
  db
    .insert(users)
    .values({ githubId, githubLogin: login, isSuperAdmin })
    .returning({ id: users.id })
    .then(([row]) => {
      if (!row) throw new Error("no seeded user")
      return row.id
    })

const seedSession = (
  db: Db,
  input: {
    id: string
    userId: string
    projectId: string
    title: string
    updatedAt: Date
  },
) =>
  db.insert(sessions).values({
    id: input.id,
    source: "claude_code",
    userId: input.userId,
    projectId: input.projectId,
    title: input.title,
    updatedAt: input.updatedAt,
  })

const seedMessage = async (
  db: Db,
  input: {
    sessionId: string
    lineNumber: number
    timestamp: Date
    tokens?: number
    repoId?: string
  },
): Promise<void> => {
  const [row] = await db
    .insert(messages)
    .values({
      sessionId: input.sessionId,
      lineUuid: crypto.randomUUID(),
      subIndex: 0,
      msgType: "message",
      role: "assistant",
      timestamp: input.timestamp,
      lineNumber: input.lineNumber,
      repoId: input.repoId,
      raw: {},
      sourceSchemaVersion: 1,
    })
    .returning({ id: messages.id })
  if (!row) throw new Error("no seeded message")
  if (input.tokens === undefined) return
  await db.insert(tokenUsage).values({
    messageId: row.id,
    inputTokens: input.tokens,
    outputTokens: 0,
    cachedTokens: 0,
    thinkingTokens: 0,
  })
}

const request = async (db: Db, userId: string, query: string): Promise<Response> => {
  const token = await signToken(env, { sub: userId, aud: "web" })
  return buildApp(db, env).request(`/api/sessions${query}`, {
    headers: { cookie: `session=${token}` },
  })
}

const listAs = async (
  db: Db,
  userId: string,
  query = "",
): Promise<ReadonlyArray<SessionSummary>> => {
  const res = await request(db, userId, query)
  expect(res.status).toBe(200)
  const body = (await res.json()) as { sessions: ReadonlyArray<SessionSummary> }
  return body.sessions
}

const idsOf = (rows: ReadonlyArray<SessionSummary>): ReadonlyArray<string> => rows.map((r) => r.id)

const sortedIdsOf = (rows: ReadonlyArray<SessionSummary>): ReadonlyArray<string> =>
  [...idsOf(rows)].sort()

describe.skipIf(!dockerAvailable())("GET /api/sessions", () => {
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

  test("a super admin reads a stranger's session through the search CTE, where the predicate is hand-written SQL", async () => {
    const stranger = await seedUser(db, 1900, "stranger")
    const admin = await seedUser(db, 1901, "the-admin", true)
    const nobody = await seedUser(db, 1902, "nobody")
    const projectId = await projectsRepo.upsert(db, {
      identity: { name: "Locked", slug: "locked" },
      ownerId: stranger,
    })
    await seedSession(db, {
      id: "locked-session",
      userId: stranger,
      projectId,
      title: "Locked",
      updatedAt: new Date(),
    })

    // sessions.repo.ts interpolates visibleToUser into a raw CTE alongside its own `users` join:
    // an alias collision or a mis-parenthesised OR would surface here and nowhere else.
    expect(idsOf(await listAs(db, admin))).toEqual(["locked-session"])
    expect(idsOf(await listAs(db, nobody))).toEqual([])

    const detail = await request(db, admin, "/locked-session")
    expect(detail.status).toBe(200)
  })

  test("S20: project, user, and range each narrow the list on their own - an unfiltered request returns all four sessions", async () => {
    const owner = await seedUser(db, 1001, "owner")
    const maya = await seedUser(db, 1002, "maya")
    const alpha = await projectsRepo.upsert(db, {
      identity: { name: "Alpha", slug: "alpha" },
      ownerId: owner,
    })
    const beta = await projectsRepo.upsert(db, {
      identity: { name: "Beta", slug: "beta" },
      ownerId: owner,
    })

    const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000)
    const now = new Date()

    await seedSession(db, {
      id: "alpha-owner-old",
      userId: owner,
      projectId: alpha,
      title: "A",
      updatedAt: old,
    })
    await seedSession(db, {
      id: "alpha-maya-now",
      userId: maya,
      projectId: alpha,
      title: "B",
      updatedAt: now,
    })
    await seedSession(db, {
      id: "beta-owner-now",
      userId: owner,
      projectId: beta,
      title: "C",
      updatedAt: now,
    })
    await seedSession(db, {
      id: "beta-maya-old",
      userId: maya,
      projectId: beta,
      title: "D",
      updatedAt: old,
    })

    expect(sortedIdsOf(await listAs(db, owner))).toEqual([
      "alpha-maya-now",
      "alpha-owner-old",
      "beta-maya-old",
      "beta-owner-now",
    ])

    expect(sortedIdsOf(await listAs(db, owner, `?project=${alpha}`))).toEqual([
      "alpha-maya-now",
      "alpha-owner-old",
    ])

    expect(sortedIdsOf(await listAs(db, owner, "?user=maya"))).toEqual([
      "alpha-maya-now",
      "beta-maya-old",
    ])

    expect(sortedIdsOf(await listAs(db, owner, "?range=today"))).toEqual([
      "alpha-maya-now",
      "beta-owner-now",
    ])

    expect(idsOf(await listAs(db, owner, `?project=${alpha}&user=maya`))).toEqual([
      "alpha-maya-now",
    ])
  })

  test("S20: sessions in projects the user cannot see are excluded even with no filters set", async () => {
    const ownerA = await seedUser(db, 1101, "owner-a")
    const outsiderB = await seedUser(db, 1102, "outsider-b")
    const projectA = await projectsRepo.upsert(db, {
      identity: { name: "Private", slug: "private" },
      ownerId: ownerA,
    })
    const projectB = await projectsRepo.upsert(db, {
      identity: { name: "Public", slug: "public" },
      ownerId: outsiderB,
    })
    await seedSession(db, {
      id: "hidden",
      userId: ownerA,
      projectId: projectA,
      title: "Hidden",
      updatedAt: new Date(),
    })
    await seedSession(db, {
      id: "visible",
      userId: outsiderB,
      projectId: projectB,
      title: "Visible",
      updatedAt: new Date(),
    })

    expect(idsOf(await listAs(db, outsiderB))).toEqual(["visible"])
  })

  test("S21: three sessions come back newest-updated first - not in insertion order", async () => {
    const owner = await seedUser(db, 1201, "ordering-owner")
    const projectId = await projectsRepo.upsert(db, {
      identity: { name: "Ordered", slug: "ordered" },
      ownerId: owner,
    })

    await seedSession(db, {
      id: "middle",
      userId: owner,
      projectId,
      title: "Middle",
      updatedAt: new Date("2026-02-02T00:00:00Z"),
    })
    await seedSession(db, {
      id: "oldest",
      userId: owner,
      projectId,
      title: "Oldest",
      updatedAt: new Date("2026-02-01T00:00:00Z"),
    })
    await seedSession(db, {
      id: "newest",
      userId: owner,
      projectId,
      title: "Newest",
      updatedAt: new Date("2026-02-03T00:00:00Z"),
    })

    expect(idsOf(await listAs(db, owner))).toEqual(["newest", "middle", "oldest"])
  })

  test("keyword search, pagination, and structured validation use the paginated list envelope", async () => {
    const owner = await seedUser(db, 1251, "search-owner")
    const projectId = await projectsRepo.upsert(db, {
      identity: { name: "Search", slug: "search" },
      ownerId: owner,
    })
    await seedSession(db, {
      id: "keyword-one",
      userId: owner,
      projectId,
      title: "Needle first",
      updatedAt: new Date("2026-02-01T00:00:00Z"),
    })
    await seedSession(db, {
      id: "keyword-two",
      userId: owner,
      projectId,
      title: "Needle second",
      updatedAt: new Date("2026-02-02T00:00:00Z"),
    })
    await seedSession(db, {
      id: "unmatched",
      userId: owner,
      projectId,
      title: "Haystack",
      updatedAt: new Date("2026-02-03T00:00:00Z"),
    })

    const response = await request(db, owner, "?q=needle&limit=1&page=2")
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      sessions: ReadonlyArray<SessionSummary & { match?: { sourceKind: string } }>
      pagination: { page: number; limit: number; total: number; totalPages: number }
      filterOptions: { projects: ReadonlyArray<{ value: string }> }
    }
    expect(body.sessions).toHaveLength(1)
    expect(body.sessions[0]?.id).toBe("keyword-one")
    expect(body.sessions[0]?.match?.sourceKind).toBe("session")
    expect(body.pagination).toEqual({ page: 2, limit: 1, total: 2, totalPages: 2 })
    expect(body.filterOptions.projects.map((option) => option.value)).toEqual([projectId])

    for (const query of [
      "?pr=01",
      "?pr=2147483648",
      "?commit=not-a-sha",
      "?q=OR",
      "?q=___",
      "?q=auth_guard",
      "?q=auth+-___",
    ]) {
      const invalid = await request(db, owner, query)
      expect(invalid.status).toBe(400)
    }

    for (const query of [
      "?range=custom&from=2026-02-30&to=2026-03-01&tz=UTC",
      "?range=custom&from=2026-99-99&to=2027-01-01&tz=UTC",
    ]) {
      const invalid = await request(db, owner, query)
      expect(invalid.status).toBe(400)
      expect(await invalid.json()).toEqual({ error: "invalidFilter" })
    }

    const leapDay = await request(db, owner, "?range=custom&from=2024-02-29&to=2024-02-29&tz=UTC")
    expect(leapDay.status).toBe(200)
  })

  test("keyword matches and headlines come only from the five approved source documents", async () => {
    const owner = await seedUser(db, 1271, "five-source-owner")
    const projectId = await projectsRepo.upsert(db, {
      identity: { name: "Five", slug: "five" },
      ownerId: owner,
    })
    const repoId = await reposRepo.upsertByIdentity(
      db,
      { host: "github.com", owner: "acme", repoName: "five" },
      owner,
    )
    const now = new Date("2026-02-01T00:00:00Z")
    for (const [id, title] of [
      ["source-session", "sessionneedle"],
      ["source-message", "other"],
      ["source-pr", "other"],
      ["source-call", "other"],
      ["source-result", "other"],
      ["excluded", "other"],
    ] as const) {
      await seedSession(db, { id, userId: owner, projectId, title, updatedAt: now })
    }
    const insertMessageFor = async (sessionId: string, content: unknown, raw: unknown = {}) => {
      const [message] = await db
        .insert(messages)
        .values({
          sessionId,
          lineUuid: crypto.randomUUID(),
          subIndex: 0,
          msgType: "message",
          role: "assistant",
          timestamp: now,
          lineNumber: 1,
          content,
          raw,
          sourceSchemaVersion: 1,
        })
        .returning({ id: messages.id })
      if (!message) throw new Error("message not inserted")
      return message.id
    }
    await insertMessageFor("source-message", { value: "messageneedle" })
    const callMessageId = await insertMessageFor("source-call", {})
    const resultMessageId = await insertMessageFor("source-result", {})
    await insertMessageFor("excluded", {}, { hidden: "rawneedle" })
    await db.insert(toolCall).values({
      toolId: "call-needle",
      messageId: callMessageId,
      toolName: "not-searchable",
      toolInput: { value: "callneedle" },
    })
    await db.insert(toolResult).values({
      toolId: "result-needle",
      messageId: resultMessageId,
      status: "success",
      result: { value: "resultneedle" },
    })
    const [pr] = await db
      .insert(pullRequests)
      .values({ repoId, number: 77, title: "prneedle" })
      .returning({ id: pullRequests.id })
    if (!pr) throw new Error("pr not inserted")
    await db.insert(sessionPullRequests).values({ sessionId: "source-pr", prId: pr.id })
    await db
      .insert(commits)
      .values({ repoId, sessionId: "excluded", sha: "abcdef0123456789", subject: "commitneedle" })

    for (const [q, id, sourceKind] of [
      ["sessionneedle", "source-session", "session"],
      ["messageneedle", "source-message", "message"],
      ["prneedle", "source-pr", "pullRequest"],
      ["callneedle", "source-call", "toolCall"],
      ["resultneedle", "source-result", "toolResult"],
    ] as const) {
      const response = await request(db, owner, `?q=${q}`)
      expect(response.status).toBe(200)
      const body = (await response.json()) as {
        sessions: ReadonlyArray<{
          id: string
          match?: {
            sourceKind: string
            sourceRowId: string
            snippet: ReadonlyArray<{ text: string; highlighted: boolean }>
          }
        }>
      }
      expect(body.sessions.map((session) => session.id)).toEqual([id])
      expect(body.sessions[0]?.match?.sourceKind).toBe(sourceKind)
      expect(body.sessions[0]?.match?.snippet.some((segment) => segment.highlighted)).toBe(true)
    }
    expect(await listAs(db, owner, "?q=rawneedle")).toEqual([])
    expect(await listAs(db, owner, "?q=commitneedle")).toEqual([])
  })

  test("S20, SC29: a summary carries the project id, name, login, summed tokens, and a duration spanning the message timestamps", async () => {
    const owner = await seedUser(db, 1301, "shape-owner")
    const projectId = await projectsRepo.upsert(db, {
      identity: { name: "Shape", slug: "shape" },
      ownerId: owner,
    })
    await seedSession(db, {
      id: "shaped",
      userId: owner,
      projectId,
      title: "Shaped session",
      updatedAt: new Date("2026-02-05T12:00:00Z"),
    })
    await seedMessage(db, {
      sessionId: "shaped",
      lineNumber: 1,
      timestamp: new Date("2026-02-05T10:00:00Z"),
      tokens: 100,
    })
    await seedMessage(db, {
      sessionId: "shaped",
      lineNumber: 2,
      timestamp: new Date("2026-02-05T11:30:00Z"),
      tokens: 250,
    })

    const [summary] = await listAs(db, owner)

    expect(summary).toEqual({
      id: "shaped",
      title: "Shaped session",
      projectId,
      projectName: "Shape",
      projectSlug: "shape",
      userLogin: "shape-owner",
      repo: null,
      durationMs: 5_400_000,
      tokensTotal: 350,
      status: "complete",
      lastActiveAt: new Date("2026-02-05T12:00:00Z").toISOString(),
    })
  })

  test("S20: a summary names the repo most of its messages ran in - a session spanning two repos reports the dominant one, not both", async () => {
    const owner = await seedUser(db, 1501, "repo-owner")
    const projectId = await projectsRepo.upsert(db, {
      identity: { name: "Repo", slug: "repo" },
      ownerId: owner,
    })
    const main = await reposRepo.upsertByIdentity(
      db,
      { host: "github.com", owner: "acme", repoName: "samskara" },
      owner,
    )
    const vendored = await reposRepo.upsertByIdentity(
      db,
      { host: "github.com", owner: "acme", repoName: "vendor" },
      owner,
    )
    await seedSession(db, {
      id: "repo-session",
      userId: owner,
      projectId,
      title: "Repo session",
      updatedAt: new Date("2026-02-06T12:00:00Z"),
    })
    await seedMessage(db, {
      sessionId: "repo-session",
      lineNumber: 1,
      timestamp: new Date("2026-02-06T10:00:00Z"),
      repoId: vendored,
    })
    for (const lineNumber of [2, 3]) {
      await seedMessage(db, {
        sessionId: "repo-session",
        lineNumber,
        timestamp: new Date("2026-02-06T11:00:00Z"),
        repoId: main,
      })
    }

    const [summary] = await listAs(db, owner)

    expect(summary?.repo).toEqual({ host: "github.com", owner: "acme", repoName: "samskara" })
  })

  test("S20: a session with no messages reports a null duration and zero tokens with status empty - not a zero duration", async () => {
    const owner = await seedUser(db, 1401, "bare-owner")
    const projectId = await projectsRepo.upsert(db, {
      identity: { name: "Bare", slug: "bare" },
      ownerId: owner,
    })
    await seedSession(db, {
      id: "bare",
      userId: owner,
      projectId,
      title: "Bare",
      updatedAt: new Date("2026-02-06T00:00:00Z"),
    })

    const [summary] = await listAs(db, owner)

    expect(summary?.durationMs).toBeNull()
    expect(summary?.tokensTotal).toBe(0)
    expect(summary?.status).toBe("empty")
  })

  test("S22, SC28: filtering by a project owned by someone else with no grant is 404 projectNotFound - not a 200 with an empty list", async () => {
    const ownerA = await seedUser(db, 1501, "denied-owner")
    const userB = await seedUser(db, 1502, "denied-b")
    const projectId = await projectsRepo.upsert(db, {
      identity: { name: "Locked", slug: "locked" },
      ownerId: ownerA,
    })
    await seedSession(db, {
      id: "locked-session",
      userId: ownerA,
      projectId,
      title: "Locked",
      updatedAt: new Date(),
    })

    const res = await request(db, userB, `?project=${projectId}`)

    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: "projectNotFound" })
  })

  test("S22, SC28: a nonexistent project id is also 404, a non-UUID value is 400, and a viewer grant turns the id into a 200", async () => {
    const ownerA = await seedUser(db, 1601, "grant-owner")
    const granteeB = await seedUser(db, 1602, "grant-b")
    const projectId = await projectsRepo.upsert(db, {
      identity: { name: "Granted", slug: "granted" },
      ownerId: ownerA,
    })
    await seedSession(db, {
      id: "granted-session",
      userId: ownerA,
      projectId,
      title: "Granted",
      updatedAt: new Date(),
    })

    const notUuid = await request(db, granteeB, "?project=does-not-exist")
    expect(notUuid.status).toBe(400)
    expect(await notUuid.json()).toEqual({ error: "invalidProject" })

    const missing = await request(db, granteeB, "?project=00000000-0000-4000-8000-000000000000")
    expect(missing.status).toBe(404)

    const beforeGrant = await request(db, granteeB, `?project=${projectId}`)
    expect(beforeGrant.status).toBe(404)

    await projectsRepo.grant(db, granteeB, projectId, "viewer")

    expect(idsOf(await listAs(db, granteeB, `?project=${projectId}`))).toEqual(["granted-session"])
  })

  test("S22: no cookie and a cli-audience token are both 401 unauthorized on the sessions read endpoint", async () => {
    const owner = await seedUser(db, 1701, "guard-owner")
    const app = buildApp(db, env)

    const anonymous = await app.request("/api/sessions")
    expect(anonymous.status).toBe(401)
    expect(await anonymous.json()).toEqual({ error: "unauthorized" })

    const cliToken = await signToken(env, { sub: owner, aud: "cli" })
    const cli = await app.request("/api/sessions", { headers: { cookie: `session=${cliToken}` } })
    expect(cli.status).toBe(401)
    expect(await cli.json()).toEqual({ error: "unauthorized" })
  })

  test("S20: an unrecognized range is rejected by validation rather than silently widening the result", async () => {
    const owner = await seedUser(db, 1801, "range-owner")

    const res = await request(db, owner, "?range=banana")

    expect(res.status).toBe(400)
  })

  test("SC27: the session list filters by project id and offers ids as filter values", async () => {
    const owner = await seedUser(db, 1901, "sc27-owner")
    const projectA = await projectsRepo.upsert(db, {
      identity: { name: "Alpha", slug: "sc27-alpha" },
      ownerId: owner,
    })
    const projectB = await projectsRepo.upsert(db, {
      identity: { name: "Beta", slug: "sc27-beta" },
      ownerId: owner,
    })
    await seedSession(db, {
      id: "sc27-a",
      userId: owner,
      projectId: projectA,
      title: "A",
      updatedAt: new Date(),
    })
    await seedSession(db, {
      id: "sc27-b",
      userId: owner,
      projectId: projectB,
      title: "B",
      updatedAt: new Date(),
    })

    expect(idsOf(await listAs(db, owner, `?project=${projectA}`))).toEqual(["sc27-a"])

    const res = await request(db, owner, "")
    const body = (await res.json()) as {
      filterOptions: { projects: ReadonlyArray<{ value: string; label: string }> }
    }
    expect(body.filterOptions.projects).toEqual([
      { value: projectA, label: "Alpha" },
      { value: projectB, label: "Beta" },
    ])
  })

  test("SC30: two visible projects with the same slug are two distinct filter options", async () => {
    const owner = await seedUser(db, 1911, "sc30-owner")
    const [org] = await db
      .insert(orgs)
      .values({ githubSlug: "sc30-acme", name: "Acme" })
      .returning({ id: orgs.id })
    if (!org) throw new Error("seed org failed")
    await db.insert(userOrgs).values({ userId: owner, orgId: org.id })

    const { id: personal } = await projectsRepo.upsertOwned(db, {
      identity: { name: "widget", slug: "sc30-widget" },
      owner: { kind: "user", userId: owner },
    })
    const { id: orgOwned } = await projectsRepo.upsertOwned(db, {
      identity: { name: "widget", slug: "sc30-widget" },
      owner: { kind: "org", orgId: org.id },
    })
    await seedSession(db, {
      id: "sc30-personal",
      userId: owner,
      projectId: personal,
      title: "Personal",
      updatedAt: new Date(),
    })
    await seedSession(db, {
      id: "sc30-org",
      userId: owner,
      projectId: orgOwned,
      title: "Org",
      updatedAt: new Date(),
    })

    const res = await request(db, owner, "")
    const body = (await res.json()) as {
      filterOptions: { projects: ReadonlyArray<{ value: string; label: string }> }
    }
    const widgetOptions = body.filterOptions.projects.filter((option) => option.label === "widget")
    expect(widgetOptions.map((option) => option.value).sort()).toEqual([personal, orgOwned].sort())

    expect(idsOf(await listAs(db, owner, `?project=${personal}`))).toEqual(["sc30-personal"])
    expect(idsOf(await listAs(db, owner, `?project=${orgOwned}`))).toEqual(["sc30-org"])
  })
})

type DetailMessage = {
  readonly id: string
  readonly msgType: string
  readonly role: string | null
  readonly lineNumber: number
  readonly timestamp: string | null
  readonly agentId: string | null
  readonly content: unknown
  readonly details: unknown
}

type DetailToolCall = {
  readonly toolId: string
  readonly messageId: string
  readonly toolName: string
  readonly toolInput: unknown
  readonly result: unknown
  readonly status: string | null
}

type DetailSubagent = {
  readonly agentId: string
  readonly agentType: string | null
  readonly description: string | null
  readonly parentAgentId: string | null
}

type SessionDetailBody = {
  readonly session: {
    readonly id: string
    readonly title: string | null
    readonly projectName: string
    readonly projectSlug: string
    readonly userLogin: string
    readonly repo: SessionRepo | null
    readonly durationMs: number | null
    readonly messageCount: number
    readonly toolCallCount: number
    readonly subagentCount: number
    readonly lastActiveAt: string
  }
  readonly messages: ReadonlyArray<DetailMessage>
  readonly toolCalls: ReadonlyArray<DetailToolCall>
  readonly subagents: ReadonlyArray<DetailSubagent>
  readonly tokenUsage: {
    readonly inputTokens: number
    readonly outputTokens: number
    readonly cachedTokens: number
    readonly thinkingTokens: number
  }
}

const insertMessage = async (
  db: Db,
  input: {
    sessionId: string
    lineNumber: number
    msgType: string
    role?: string
    timestamp?: Date
    agentId?: string
    isSubagent?: boolean
    content?: unknown
    details?: unknown
    repoId?: string
  },
): Promise<string> => {
  const [row] = await db
    .insert(messages)
    .values({
      sessionId: input.sessionId,
      lineUuid: crypto.randomUUID(),
      subIndex: 0,
      msgType: input.msgType,
      role: input.role,
      repoId: input.repoId,
      timestamp: input.timestamp,
      lineNumber: input.lineNumber,
      agentId: input.agentId,
      isSubagent: input.isSubagent ?? false,
      content: input.content,
      details: input.details,
      raw: {},
      sourceSchemaVersion: 1,
    })
    .returning({ id: messages.id })
  if (!row) throw new Error("no seeded message")
  return row.id
}

const detailRequest = async (db: Db, userId: string, sessionId: string): Promise<Response> => {
  const token = await signToken(env, { sub: userId, aud: "web" })
  return buildApp(db, env).request(`/api/sessions/${sessionId}`, {
    headers: { cookie: `session=${token}` },
  })
}

/** Bearer + `cli` audience: the delete route is deliberately closed to the browser's token. */
const deleteRequest = async (db: Db, userId: string, sessionId: string): Promise<Response> => {
  const token = await signToken(env, { sub: userId, aud: "cli" })
  return buildApp(db, env).request(`/api/sessions/${sessionId}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}` },
  })
}

describe.skipIf(!dockerAvailable())("GET /api/sessions/:id", () => {
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

  test("S39, SC29: a session with messages, a tool call pair, a subagent and token usage returns all five sections - messages ordered by lineNumber, not insertion order", async () => {
    const owner = await seedUser(db, 2001, "detail-owner")
    const projectId = await projectsRepo.upsert(db, {
      identity: { name: "Detail", slug: "detail" },
      ownerId: owner,
    })
    await seedSession(db, {
      id: "detailed",
      userId: owner,
      projectId,
      title: "Detailed session",
      updatedAt: new Date("2026-03-01T12:00:00Z"),
    })

    const second = await insertMessage(db, {
      sessionId: "detailed",
      lineNumber: 2,
      msgType: "toolCall",
      role: "assistant",
      timestamp: new Date("2026-03-01T10:05:00Z"),
    })
    const first = await insertMessage(db, {
      sessionId: "detailed",
      lineNumber: 1,
      msgType: "message",
      role: "user",
      timestamp: new Date("2026-03-01T10:00:00Z"),
      content: { text: "Make ingest idempotent" },
    })

    await db.insert(toolCall).values({
      toolId: "tool-1",
      messageId: second,
      toolName: "Grep",
      toolInput: { pattern: "INSERT INTO" },
    })
    await db.insert(toolResult).values({
      toolId: "tool-1",
      messageId: second,
      result: { matches: 3 },
      status: "success",
    })
    await db.insert(subagents).values({
      sessionId: "detailed",
      agentId: "agent-audit",
      agentType: "db-schema-auditor",
      description: "Audit unique constraints",
      spawnToolUseId: "toolu_016HFcaNDieHnTH4Nty25mXr",
      sourceRelativePath: "sub/agent-audit.jsonl",
    })
    await db.insert(tokenUsage).values({
      messageId: first,
      inputTokens: 120,
      outputTokens: 40,
      cachedTokens: 10,
      thinkingTokens: 5,
    })

    const res = await detailRequest(db, owner, "detailed")
    expect(res.status).toBe(200)
    const body = (await res.json()) as SessionDetailBody

    expect(body.session).toMatchObject({
      id: "detailed",
      title: "Detailed session",
      projectId,
      projectName: "Detail",
      projectSlug: "detail",
      userLogin: "detail-owner",
      messageCount: 2,
      toolCallCount: 1,
      subagentCount: 1,
      durationMs: 300_000,
    })
    expect(body.messages.map((m) => m.lineNumber)).toEqual([1, 2])
    expect(body.messages[0]?.content).toEqual({ text: "Make ingest idempotent" })
    expect(body.toolCalls).toEqual([
      {
        toolId: "tool-1",
        messageId: second,
        toolName: "Grep",
        toolInput: { pattern: "INSERT INTO" },
        result: { matches: 3 },
        status: "success",
      },
    ])
    expect(body.subagents).toEqual([
      {
        agentId: "agent-audit",
        agentType: "db-schema-auditor",
        description: "Audit unique constraints",
        parentAgentId: null,
        spawnToolUseId: "toolu_016HFcaNDieHnTH4Nty25mXr",
      },
    ])
    expect(body.tokenUsage).toEqual({
      inputTokens: 120,
      outputTokens: 40,
      cachedTokens: 10,
      thinkingTokens: 5,
    })
  })

  test("S39: a tool call whose result never arrived still appears with a null status - the call is evidence even without its outcome", async () => {
    const owner = await seedUser(db, 2101, "pending-owner")
    const projectId = await projectsRepo.upsert(db, {
      identity: { name: "Pending", slug: "pending" },
      ownerId: owner,
    })
    await seedSession(db, {
      id: "pending",
      userId: owner,
      projectId,
      title: "Pending",
      updatedAt: new Date(),
    })
    const messageId = await insertMessage(db, {
      sessionId: "pending",
      lineNumber: 1,
      msgType: "toolCall",
    })
    await db
      .insert(toolCall)
      .values({ toolId: "orphan", messageId, toolName: "Bash", toolInput: { cmd: "ls" } })

    const res = await detailRequest(db, owner, "pending")
    const body = (await res.json()) as SessionDetailBody

    expect(body.toolCalls).toEqual([
      {
        toolId: "orphan",
        messageId,
        toolName: "Bash",
        toolInput: { cmd: "ls" },
        result: null,
        status: null,
      },
    ])
  })

  test("S39: the detail facts carry the session's repo, and a session whose messages carry none reports null", async () => {
    const owner = await seedUser(db, 2151, "repo-detail-owner")
    const projectId = await projectsRepo.upsert(db, {
      identity: { name: "RepoDetail", slug: "repo-detail" },
      ownerId: owner,
    })
    const repoId = await reposRepo.upsertByIdentity(
      db,
      { host: "local", owner: "/Users/maya/Projects/samskara", repoName: "samskara" },
      owner,
    )
    for (const [id, attributed] of [
      ["with-repo", true],
      ["without-repo", false],
    ] as const) {
      await seedSession(db, { id, userId: owner, projectId, title: id, updatedAt: new Date() })
      await insertMessage(db, {
        sessionId: id,
        lineNumber: 1,
        msgType: "message",
        repoId: attributed ? repoId : undefined,
      })
    }

    const repoOf = async (id: string) => {
      const res = await detailRequest(db, owner, id)
      const body = (await res.json()) as SessionDetailBody
      return body.session.repo
    }

    expect(await repoOf("with-repo")).toEqual({
      host: "local",
      owner: "/Users/maya/Projects/samskara",
      repoName: "samskara",
    })
    expect(await repoOf("without-repo")).toBeNull()
  })

  test("EDGE-008 S40: an id that exists for nobody is 404 sessionNotFound - not 200 with an empty payload", async () => {
    const owner = await seedUser(db, 2201, "missing-owner")

    const res = await detailRequest(db, owner, "does-not-exist")

    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: "sessionNotFound" })
  })

  test("S41: user B reading a session in user A's ungranted project gets 404 sessionNotFound - not 403, which would confirm the session exists", async () => {
    const ownerA = await seedUser(db, 2301, "private-owner")
    const userB = await seedUser(db, 2302, "outsider")
    const projectId = await projectsRepo.upsert(db, {
      identity: { name: "Sealed", slug: "sealed" },
      ownerId: ownerA,
    })
    await seedSession(db, {
      id: "sealed-session",
      userId: ownerA,
      projectId,
      title: "Sealed",
      updatedAt: new Date(),
    })
    await insertMessage(db, { sessionId: "sealed-session", lineNumber: 1, msgType: "message" })

    const denied = await detailRequest(db, userB, "sealed-session")

    expect(denied.status).toBe(404)
    expect(await denied.json()).toEqual({ error: "sessionNotFound" })

    await projectsRepo.grant(db, userB, projectId, "viewer")
    const granted = await detailRequest(db, userB, "sealed-session")
    expect(granted.status).toBe(200)
  })

  test("S41: a detail read with no cookie is 401 unauthorized before any lookup happens", async () => {
    const res = await buildApp(db, env).request("/api/sessions/anything")

    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: "unauthorized" })
  })

  test("S42: deleting a session takes everything it owns with it, so a replay re-ingests into an empty slot", async () => {
    const owner = await seedUser(db, 2401, "replay-owner")
    const projectId = await projectsRepo.upsert(db, {
      identity: { name: "Replay", slug: "replay" },
      ownerId: owner,
    })
    await seedSession(db, {
      id: "replayable",
      userId: owner,
      projectId,
      title: "Replayable",
      updatedAt: new Date(),
    })
    const messageId = await insertMessage(db, {
      sessionId: "replayable",
      lineNumber: 1,
      msgType: "toolCall",
    })
    await db.insert(toolCall).values({ toolId: "t-r", messageId, toolName: "Grep", toolInput: {} })
    await db.insert(subagents).values({
      sessionId: "replayable",
      agentId: "agent-r",
      sourceRelativePath: "sub/agent-r.jsonl",
    })
    await db.insert(artifact).values({
      sessionId: "replayable",
      path: "/work/app/docs/a.md",
      relativePath: "docs/a.md",
      mimeType: "text/markdown",
      isBinary: false,
      currentContent: Buffer.from("hi"),
      currentHash: "hash-r",
      changeKind: "created",
    })

    const res = await deleteRequest(db, owner, "replayable")
    expect(res.status).toBe(204)

    // The cascade is the whole point: one delete has to leave nothing behind for the replay to
    // collide with, so each dependent table is checked rather than the session row alone.
    expect(await db.select().from(sessions)).toHaveLength(0)
    expect(await db.select().from(messages)).toHaveLength(0)
    expect(await db.select().from(toolCall)).toHaveLength(0)
    expect(await db.select().from(subagents)).toHaveLength(0)
    expect(await db.select().from(artifact)).toHaveLength(0)
  })

  test("S42: a stranger deleting someone else's session gets 404 and the session survives", async () => {
    const ownerA = await seedUser(db, 2402, "delete-owner")
    const userB = await seedUser(db, 2403, "delete-stranger")
    const projectId = await projectsRepo.upsert(db, {
      identity: { name: "Sealed", slug: "sealed-delete" },
      ownerId: ownerA,
    })
    await seedSession(db, {
      id: "not-yours",
      userId: ownerA,
      projectId,
      title: "Sealed",
      updatedAt: new Date(),
    })

    const denied = await deleteRequest(db, userB, "not-yours")

    expect(denied.status).toBe(404)
    expect(await denied.json()).toEqual({ error: "sessionNotFound" })
    expect(await db.select().from(sessions)).toHaveLength(1)
  })

  test("S42: a web-audience token cannot delete, so the browser can never destroy captured history", async () => {
    const owner = await seedUser(db, 2404, "web-token-owner")
    const projectId = await projectsRepo.upsert(db, {
      identity: { name: "Web", slug: "web-delete" },
      ownerId: owner,
    })
    await seedSession(db, {
      id: "web-guarded",
      userId: owner,
      projectId,
      title: "Guarded",
      updatedAt: new Date(),
    })

    const webToken = await signToken(env, { sub: owner, aud: "web" })
    const res = await buildApp(db, env).request("/api/sessions/web-guarded", {
      method: "DELETE",
      headers: { cookie: `session=${webToken}` },
    })

    expect(res.status).toBe(401)
    expect(await db.select().from(sessions)).toHaveLength(1)
  })

  test("SC2: a member of the owning org reads the org project's session list and detail; a non-member cannot", async () => {
    const member = await seedUser(db, 2501, "sc2-member")
    const outsider = await seedUser(db, 2502, "sc2-outsider")
    const [org] = await db
      .insert(orgs)
      .values({ githubSlug: "sc2-acme", name: "Acme" })
      .returning({ id: orgs.id })
    if (!org) throw new Error("seed org failed")
    await db.insert(userOrgs).values({ userId: member, orgId: org.id })

    const { id: projectId } = await projectsRepo.upsertOwned(db, {
      identity: { name: "acme-widget", slug: "sc2-acme-widget" },
      owner: { kind: "org", orgId: org.id },
    })
    await seedSession(db, {
      id: "sc2-org-session",
      userId: member,
      projectId,
      title: "Org session",
      updatedAt: new Date(),
    })

    expect((await listAs(db, member)).map((s) => s.id)).toContain("sc2-org-session")
    expect((await detailRequest(db, member, "sc2-org-session")).status).toBe(200)

    expect((await listAs(db, outsider)).map((s) => s.id)).not.toContain("sc2-org-session")
    expect((await detailRequest(db, outsider, "sc2-org-session")).status).toBe(404)
  })
})
