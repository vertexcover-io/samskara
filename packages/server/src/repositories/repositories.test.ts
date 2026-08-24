import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { type Db, createDb } from "../db/client.js"
import {
  commits,
  orgs,
  projects,
  pullRequests,
  sessionPullRequests,
  sessions,
  subagents,
  tokenUsage,
  toolCall,
  userOrgs,
  users,
} from "../db/schema.js"
import * as commitsRepo from "./commits.repo.js"
import * as messagesRepo from "./messages.repo.js"
import * as orgsRepo from "./orgs.repo.js"
import * as projectsRepo from "./projects.repo.js"
import * as pullRequestsRepo from "./pullRequests.repo.js"
import * as reposRepo from "./repos.repo.js"
import * as sessionsRepo from "./sessions.repo.js"
import * as subagentsRepo from "./subagents.repo.js"
import * as tokenUsageRepo from "./tokenUsage.repo.js"
import * as toolRowsRepo from "./toolRows.repo.js"
import * as userOrgsRepo from "./userOrgs.repo.js"

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
  const seedUser = async () => {
    counter += 1
    const [user] = await db
      .insert(users)
      .values({ githubId: 500 + counter, githubLogin: `repo-user-${counter}` })
      .returning()
    if (!user) throw new Error("seed user failed")
    return user
  }

  let orgCounter = 0
  const seedOrg = async (autoAddMembers = true) => {
    orgCounter += 1
    const [org] = await db
      .insert(orgs)
      .values({ githubSlug: `repo-org-${orgCounter}`, autoAddMembers })
      .returning()
    if (!org) throw new Error("seed org failed")
    return org
  }

  const seedSession = async (id: string) => {
    const user = await seedUser()
    const projectId = await projectsRepo.upsert(db, {
      identity: { name: id, slug: `slug-${id}` },
      ownerId: user.id,
    })
    await sessionsRepo.upsert(db, {
      id,
      source: "claude_code",
      userId: user.id,
      projectId,
      fields: { title: "initial title" },
    })
    return { userId: user.id, projectId }
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

  test("sessions.upsert enriches the title without changing id; null keeps existing", async () => {
    const { userId, projectId } = await seedSession("sess-repo-enrich")
    // A non-null title on a later flush wins (coalesce excluded first).
    await sessionsRepo.upsert(db, {
      id: "sess-repo-enrich",
      source: "claude_code",
      userId,
      projectId,
      fields: { title: "later title" },
    })
    // A flush with no title keeps the existing one.
    await sessionsRepo.upsert(db, {
      id: "sess-repo-enrich",
      source: "claude_code",
      userId,
      projectId,
      fields: {},
    })
    const [row] = await db.select().from(sessions).where(eq(sessions.id, "sess-repo-enrich"))
    expect(row?.title).toBe("later title")
    expect(await sessionsRepo.existsForUser(db, "sess-repo-enrich", userId)).toBe(true)
    expect(await sessionsRepo.existsForUser(db, "nope", userId)).toBe(false)
    // Existence is not authorization: the same session is invisible to a different user.
    expect(await sessionsRepo.existsForUser(db, "sess-repo-enrich", crypto.randomUUID())).toBe(
      false,
    )
  })

  test("sessions.upsert freezes the launch context at creation: a row created without one stays null", async () => {
    const { userId, projectId } = await seedSession("sess-origin-frozen")

    await sessionsRepo.upsert(db, {
      id: "sess-origin-frozen",
      source: "claude_code",
      userId,
      projectId,
      fields: { startCwd: "/work/late", startCommit: "aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111" },
    })

    const [row] = await db.select().from(sessions).where(eq(sessions.id, "sess-origin-frozen"))
    expect(row?.cwd).toBeNull()
    expect(row?.startCommit).toBeNull()
  })

  test("projects.upsert is idempotent per (slug, ownerId) and refreshes name", async () => {
    const owner = await seedUser()
    const first = await projectsRepo.upsert(db, {
      identity: { name: "widget", slug: "acme-widget" },
      ownerId: owner.id,
    })
    const second = await projectsRepo.upsert(db, {
      identity: { name: "widget-renamed", slug: "acme-widget" },
      ownerId: owner.id,
    })
    expect(first).toBe(second)

    const rows = await db.select().from(projects).where(eq(projects.id, first))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.name).toBe("widget-renamed")
  })

  test("SC4: the database enforces exactly one owner - both null or both set is rejected, either alone is accepted", async () => {
    const owner = await seedUser()

    await expect(
      db.insert(projects).values({ name: "neither", slug: "sc4-neither" }),
    ).rejects.toThrow()

    const org = await seedOrg()
    await expect(
      db
        .insert(projects)
        .values({ name: "both", slug: "sc4-both", ownerUserId: owner.id, ownerOrgId: org.id }),
    ).rejects.toThrow()

    const [userOwned] = await db
      .insert(projects)
      .values({ name: "user-owned", slug: "sc4-user", ownerUserId: owner.id })
      .returning()
    expect(userOwned).toBeDefined()

    const [orgOwned] = await db
      .insert(projects)
      .values({ name: "org-owned", slug: "sc4-org", ownerOrgId: org.id })
      .returning()
    expect(orgOwned).toBeDefined()
  })

  test("SC5: the same slug is one row per owner, and a repeat upsertOwned returns the same row", async () => {
    const userA = await seedUser()
    const userB = await seedUser()
    const org = await seedOrg()

    const a = await projectsRepo.upsertOwned(db, {
      identity: { name: "widget", slug: "sc5-widget" },
      owner: { kind: "user", userId: userA.id },
    })
    const b = await projectsRepo.upsertOwned(db, {
      identity: { name: "widget", slug: "sc5-widget" },
      owner: { kind: "user", userId: userB.id },
    })
    const orgFirst = await projectsRepo.upsertOwned(db, {
      identity: { name: "widget", slug: "sc5-widget" },
      owner: { kind: "org", orgId: org.id },
    })
    const orgAgain = await projectsRepo.upsertOwned(db, {
      identity: { name: "widget renamed", slug: "sc5-widget" },
      owner: { kind: "org", orgId: org.id },
    })
    const aAgain = await projectsRepo.upsertOwned(db, {
      identity: { name: "widget", slug: "sc5-widget" },
      owner: { kind: "user", userId: userA.id },
    })

    const rows = await db.select().from(projects).where(eq(projects.slug, "sc5-widget"))
    expect(rows).toHaveLength(3)
    expect(orgFirst.created).toBe(true)
    expect(orgAgain.id).toBe(orgFirst.id)
    expect(orgAgain.created).toBe(false)
    expect(aAgain.id).toBe(a.id)
    expect(aAgain.id).not.toBe(b.id)
  })

  test("SC6: authority ranks owner, org member, and grant - the highest wins", async () => {
    const org = await seedOrg()
    const memberA = await seedUser()
    const outsiderB = await seedUser()
    const viewerC = await seedUser()
    const personalOwner = await seedUser()

    const orgProjectId = (
      await projectsRepo.upsertOwned(db, {
        identity: { name: "org-project", slug: "sc6-org-project" },
        owner: { kind: "org", orgId: org.id },
      })
    ).id
    await db.insert(userOrgs).values({ userId: memberA.id, orgId: org.id })
    await projectsRepo.grant(db, viewerC.id, orgProjectId, "viewer")

    expect(await projectsRepo.authorityFor(db, memberA.id, orgProjectId)).toBe("editor")
    expect(await projectsRepo.authorityFor(db, outsiderB.id, orgProjectId)).toBeNull()
    expect(await projectsRepo.authorityFor(db, viewerC.id, orgProjectId)).toBe("viewer")

    await projectsRepo.grant(db, memberA.id, orgProjectId, "viewer")
    expect(await projectsRepo.authorityFor(db, memberA.id, orgProjectId)).toBe("editor")

    const personalProjectId = await projectsRepo.upsert(db, {
      identity: { name: "personal", slug: "sc6-personal" },
      ownerId: personalOwner.id,
    })
    expect(await projectsRepo.authorityFor(db, personalOwner.id, personalProjectId)).toBe("admin")
  })

  test("SC9: a new org row defaults to autoAddMembers off, and orgsRepo.findBySlug reads it back", async () => {
    const [org] = await db.insert(orgs).values({ githubSlug: "sc9-no-flag" }).returning()
    expect(org?.autoAddMembers).toBe(false)
    expect(await orgsRepo.findBySlug(db, "sc9-no-flag")).toMatchObject({ autoAddMembers: false })
    expect(await orgsRepo.findBySlug(db, "sc9-does-not-exist")).toBeNull()
  })

  test("userOrgs.isMember reports membership before and after a link is inserted", async () => {
    const org = await seedOrg()
    const user = await seedUser()

    expect(await userOrgsRepo.isMember(db, user.id, org.id)).toBe(false)
    await db.insert(userOrgs).values({ userId: user.id, orgId: org.id })
    expect(await userOrgsRepo.isMember(db, user.id, org.id)).toBe(true)
  })

  test("repos.upsertByIdentity keys on (host, owner, repoName, userId): same path on two hosts is two repos, two users is two repos, ssh and https are one", async () => {
    const owner = await seedUser()
    const other = await seedUser()

    const gh = await reposRepo.upsertByIdentity(
      db,
      { host: "github.com", owner: "acme", repoName: "serana" },
      owner.id,
    )
    const gl = await reposRepo.upsertByIdentity(
      db,
      { host: "gitlab.com", owner: "acme", repoName: "serana" },
      owner.id,
    )
    expect(gl).not.toBe(gh)

    const theirs = await reposRepo.upsertByIdentity(
      db,
      { host: "github.com", owner: "acme", repoName: "serana" },
      other.id,
    )
    expect(theirs).not.toBe(gh)

    const again = await reposRepo.upsertByIdentity(
      db,
      { host: "github.com", owner: "acme", repoName: "serana" },
      owner.id,
    )
    expect(again).toBe(gh)
  })

  test("authorization is owner-or-grant with ordered scopes", async () => {
    const owner = await seedUser()
    const editorUser = await seedUser()
    const viewerUser = await seedUser()
    const stranger = await seedUser()
    const projectId = await projectsRepo.upsert(db, {
      identity: { name: "shared", slug: "shared-proj" },
      ownerId: owner.id,
    })

    // Owner is admin by derivation, with no grant row.
    expect(await projectsRepo.authorityFor(db, owner.id, projectId)).toBe("admin")
    expect(await projectsRepo.canWrite(db, owner.id, projectId)).toBe(true)

    await projectsRepo.grant(db, editorUser.id, projectId, "editor")
    await projectsRepo.grant(db, viewerUser.id, projectId, "viewer")

    // editor implies viewer (ordered: viewer < editor < admin).
    expect(await projectsRepo.canWrite(db, editorUser.id, projectId)).toBe(true)
    expect(await projectsRepo.canRead(db, editorUser.id, projectId)).toBe(true)

    // viewer can read but not write.
    expect(await projectsRepo.canRead(db, viewerUser.id, projectId)).toBe(true)
    expect(await projectsRepo.canWrite(db, viewerUser.id, projectId)).toBe(false)

    // stranger sees nothing.
    expect(await projectsRepo.authorityFor(db, stranger.id, projectId)).toBeNull()
    expect(await projectsRepo.canRead(db, stranger.id, projectId)).toBe(false)
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
        lineUuid: "0191d942-3ba5-7dba-9a7d-22d65b3025b7",
        subIndex: 0,
        msgType: "message",
        lineNumber: 1,
        sourceSchemaVersion: 1,
        raw: {},
      },
      {
        sessionId: "sess-msg",
        lineUuid: "0191d942-3ba5-7dba-9a7d-22d65b3025b7",
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
    expect(second.idByKey.get(messagesRepo.keyOf("0191d942-3ba5-7dba-9a7d-22d65b3025b7", 0))).toBe(
      first.idByKey.get(messagesRepo.keyOf("0191d942-3ba5-7dba-9a7d-22d65b3025b7", 0)),
    )
  })

  test("toolRows.replaceForMessage is delete-and-replace", async () => {
    await seedSession("sess-tool")
    const { idByKey } = await messagesRepo.insertManyIgnoreConflicts(db, "sess-tool", [
      {
        sessionId: "sess-tool",
        lineUuid: "0191d942-3ba5-7dba-9a7d-22d65b3025b8",
        subIndex: 0,
        msgType: "toolCall",
        lineNumber: 1,
        sourceSchemaVersion: 1,
        raw: {},
      },
    ])
    const messageId = idByKey.get(messagesRepo.keyOf("0191d942-3ba5-7dba-9a7d-22d65b3025b8", 0))
    if (!messageId) throw new Error("no message id")

    await toolRowsRepo.replaceForMessage(db, messageId, {
      call: { callId: "toolu_1", name: "Read", input: { path: "a" } },
    })
    await toolRowsRepo.replaceForMessage(db, messageId, {
      call: { callId: "toolu_1", name: "Read", input: { path: "b" } },
    })
    const calls = await db.select().from(toolCall).where(eq(toolCall.messageId, messageId))
    expect(calls).toHaveLength(1)
    expect(calls[0]?.toolInput).toEqual({ path: "b" })
  })

  test("tokenUsage.upsert overwrites the counts for a message rather than adding a row", async () => {
    await seedSession("sess-tokens")
    const { idByKey } = await messagesRepo.insertManyIgnoreConflicts(db, "sess-tokens", [
      {
        sessionId: "sess-tokens",
        lineUuid: "0191d942-3ba5-7dba-9a7d-22d65b3025b9",
        subIndex: 0,
        msgType: "usage",
        lineNumber: 1,
        sourceSchemaVersion: 1,
        raw: {},
      },
    ])
    const messageId = idByKey.get(messagesRepo.keyOf("0191d942-3ba5-7dba-9a7d-22d65b3025b9", 0))
    if (!messageId) throw new Error("no message id")

    await tokenUsageRepo.upsert(db, messageId, { input: 1, output: 2, cached: 0, thinking: 0 })
    await tokenUsageRepo.upsert(db, messageId, { input: 9, output: 2, cached: 3, thinking: 4 })

    const rows = await db.select().from(tokenUsage).where(eq(tokenUsage.messageId, messageId))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ inputTokens: 9, cachedTokens: 3, thinkingTokens: 4 })
  })

  test("S26: a session whose tokens exceed a 32-bit integer still lists, and reports the true total", async () => {
    const { userId } = await seedSession("sess-huge-tokens")
    const { idByKey } = await messagesRepo.insertManyIgnoreConflicts(db, "sess-huge-tokens", [
      {
        sessionId: "sess-huge-tokens",
        lineUuid: "0191d942-3ba5-7dba-9a7d-22d65b302600",
        subIndex: 0,
        msgType: "usage",
        lineNumber: 1,
        sourceSchemaVersion: 1,
        raw: {},
      },
    ])
    const messageId = idByKey.get(messagesRepo.keyOf("0191d942-3ba5-7dba-9a7d-22d65b302600", 0))
    if (!messageId) throw new Error("no message id")

    // Each column fits int4; their sum does not. A long-running session reaches this through
    // cached tokens alone, and the addition used to overflow and 500 the whole list route --
    // not just this row.
    await tokenUsageRepo.upsert(db, messageId, {
      input: 2_000_000_000,
      output: 2_000_000_000,
      cached: 2_000_000_000,
      thinking: 1_000_000_000,
    })

    const { rows } = await sessionsRepo.listAccessible(db, userId)
    const row = rows.find((candidate) => candidate.id === "sess-huge-tokens")
    // Typed and asserted as a number, not merely coercible to one: the route serialises this
    // straight to JSON, and a bigint arriving as a string would fail the client's schema.
    expect(typeof row?.tokensTotal).toBe("number")
    expect(row?.tokensTotal).toBe(7_000_000_000)

    const detail = await sessionsRepo.getDetail(db, userId, "sess-huge-tokens")
    expect(typeof detail?.tokenUsage.inputTokens).toBe("number")
    expect(detail?.tokenUsage.inputTokens).toBe(2_000_000_000)
    expect(detail?.tokenUsage.thinkingTokens).toBe(1_000_000_000)
  })

  describe("commits", () => {
    const seedRepo = async (repoName: string) => {
      const owner = await seedUser()
      return reposRepo.upsertByIdentity(
        db,
        { host: "github.com", owner: "acme", ownerType: "org", repoName },
        owner.id,
      )
    }

    const startSessionAt = async (sessionId: string, startCommit?: string) => {
      const { userId, projectId } = await seedSession(sessionId)
      await sessionsRepo.upsert(db, {
        id: sessionId,
        source: "claude_code",
        userId,
        projectId,
        fields: startCommit === undefined ? {} : { startCommit },
      })
    }

    test("S14: a re-observed (repoId, sha) keeps the first observation's facts", async () => {
      const sessionId = "sess-commit-dedup"
      await startSessionAt(sessionId)
      const repoId = await seedRepo("dedup-repo")

      const first = {
        repoId,
        sha: "37f3101",
        branch: "master",
        subject: "docs: enrich clients",
        filesChanged: 51,
        insertions: 1993,
        deletions: 417,
        sessionId,
      }
      await commitsRepo.insertObserved(db, [first])
      await commitsRepo.insertObserved(db, [
        { ...first, branch: "rewritten", subject: "clobbered", filesChanged: 1 },
      ])

      const rows = await db.select().from(commits).where(eq(commits.repoId, repoId))
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject(first)
    })

    test("the same sha observed in two different repos is two rows", async () => {
      const sessionId = "sess-commit-two-repos"
      await startSessionAt(sessionId)
      const serana = await seedRepo("serana-commits")
      const andromeda = await seedRepo("andromeda-commits")

      await commitsRepo.insertObserved(db, [
        { repoId: serana, sha: "deadbee", sessionId },
        { repoId: andromeda, sha: "deadbee", sessionId },
      ])

      const rows = await db.select().from(commits).where(eq(commits.sha, "deadbee"))
      expect(rows).toHaveLength(2)
      expect(new Set(rows.map((row) => row.repoId))).toEqual(new Set([serana, andromeda]))
    })

    const linkOf = async (sessionId: string, repoId: string) => {
      const [row] = await db
        .select({ number: pullRequests.number, sessionId: sessionPullRequests.sessionId })
        .from(sessionPullRequests)
        .innerJoin(pullRequests, eq(pullRequests.id, sessionPullRequests.prId))
        .where(eq(pullRequests.repoId, repoId))
      return row
    }

    test("an opened PR links the session to the repo's PR row", async () => {
      const sessionId = "sess-pr-open"
      await startSessionAt(sessionId)
      const repoId = await seedRepo("pr-open-repo")

      await pullRequestsRepo.insertOpened(db, [{ repoId, number: 59, sessionId }])

      expect(await linkOf(sessionId, repoId)).toEqual({ number: 59, sessionId })
    })

    test("a re-parse of the same creation stays one PR row and one link", async () => {
      const sessionId = "sess-pr-reparse"
      await startSessionAt(sessionId)
      const repoId = await seedRepo("pr-reparse-repo")

      await pullRequestsRepo.insertOpened(db, [{ repoId, number: 77, sessionId }])
      await pullRequestsRepo.insertOpened(db, [{ repoId, number: 77, sessionId }])

      const rows = await db.select().from(pullRequests).where(eq(pullRequests.repoId, repoId))
      expect(rows).toHaveLength(1)
      expect(await linkOf(sessionId, repoId)).toEqual({ number: 77, sessionId })
    })
  })
})
