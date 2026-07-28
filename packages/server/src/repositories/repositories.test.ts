import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { type Db, createDb } from "../db/client.js"
import {
  commits,
  projects,
  pullRequests,
  sessionPullRequests,
  sessions,
  subagents,
  tokenUsage,
  toolCall,
  users,
} from "../db/schema.js"
import * as commitsRepo from "./commits.repo.js"
import * as messagesRepo from "./messages.repo.js"
import * as projectsRepo from "./projects.repo.js"
import * as pullRequestsRepo from "./pullRequests.repo.js"
import * as reposRepo from "./repos.repo.js"
import * as sessionsRepo from "./sessions.repo.js"
import * as subagentsRepo from "./subagents.repo.js"
import * as tokenUsageRepo from "./tokenUsage.repo.js"
import * as toolRowsRepo from "./toolRows.repo.js"

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

  describe("commits", () => {
    const lineUuidFor = (index: number) =>
      `0191d942-3ba5-7dba-9a7d-22d65b30${String(3100 + index).padStart(4, "0")}`

    /** Seeds `count` messages at lines 1..count and returns their ids keyed by line number. */
    const seedMessages = async (
      sessionId: string,
      count: number,
    ): Promise<ReadonlyMap<number, string>> => {
      const { idByKey } = await messagesRepo.insertManyIgnoreConflicts(
        db,
        sessionId,
        Array.from({ length: count }, (_unused, index) => ({
          sessionId,
          lineUuid: lineUuidFor(index),
          subIndex: 0,
          msgType: "message" as const,
          lineNumber: index + 1,
          sourceSchemaVersion: 1,
          raw: {},
        })),
      )
      return new Map(
        Array.from({ length: count }, (_unused, index) => {
          const id = idByKey.get(messagesRepo.keyOf(lineUuidFor(index), 0))
          if (!id) throw new Error(`no message id for line ${index + 1}`)
          return [index + 1, id] as const
        }),
      )
    }

    const seedRepo = (repoName: string) =>
      reposRepo.upsertByIdentity(db, {
        host: "github.com",
        owner: "acme",
        ownerType: "org",
        repoName,
      })

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
      // A re-parse offering different facts for the same sha must not win: a sha's facts
      // never change, so the first observation is authoritative.
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

    test("S23: each message reports the commit it was running on, not the one it produced", async () => {
      const sessionId = "sess-head-at"
      await startSessionAt(sessionId, "aaa1111")
      const repoId = await seedRepo("head-at-repo")
      const byLine = await seedMessages(sessionId, 40)

      await commitsRepo.insertObserved(db, [
        { repoId, sha: "bbb2222", sessionId, messageId: byLine.get(10) },
        { repoId, sha: "ccc3333", sessionId, messageId: byLine.get(30) },
      ])

      const head = await commitsRepo.headAtMessages(db, sessionId)
      const at = (line: number) => head.get(byLine.get(line) ?? "")

      expect(at(1)).toBe("aaa1111")
      expect(at(9)).toBe("aaa1111")
      // The commit's own message ran against the previous head; the head advances after it.
      expect(at(10)).toBe("aaa1111")
      expect(at(11)).toBe("bbb2222")
      expect(at(29)).toBe("bbb2222")
      expect(at(30)).toBe("bbb2222")
      expect(at(31)).toBe("ccc3333")
      expect(at(40)).toBe("ccc3333")
    })

    test("S23b: different starting shas and commit positions move the boundaries with them", async () => {
      const sessionId = "sess-head-at-varied"
      await startSessionAt(sessionId, "0f0f0f0")
      const repoId = await seedRepo("head-at-varied-repo")
      const byLine = await seedMessages(sessionId, 12)

      await commitsRepo.insertObserved(db, [
        { repoId, sha: "1a1a1a1", sessionId, messageId: byLine.get(3) },
        { repoId, sha: "2b2b2b2", sessionId, messageId: byLine.get(8) },
      ])

      const head = await commitsRepo.headAtMessages(db, sessionId)
      const shaByLine = [...byLine.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, id]) => head.get(id))

      expect(shaByLine).toEqual([
        "0f0f0f0",
        "0f0f0f0",
        "0f0f0f0",
        "1a1a1a1",
        "1a1a1a1",
        "1a1a1a1",
        "1a1a1a1",
        "1a1a1a1",
        "2b2b2b2",
        "2b2b2b2",
        "2b2b2b2",
        "2b2b2b2",
      ])
    })

    test("S24: a session with no starting sha reports null until its first commit", async () => {
      const sessionId = "sess-head-at-null"
      await startSessionAt(sessionId)
      const repoId = await seedRepo("head-at-null-repo")
      const byLine = await seedMessages(sessionId, 8)

      await commitsRepo.insertObserved(db, [
        { repoId, sha: "eee5555", sessionId, messageId: byLine.get(5) },
      ])

      const head = await commitsRepo.headAtMessages(db, sessionId)
      const at = (line: number) => head.get(byLine.get(line) ?? "")

      expect(at(1)).toBeNull()
      expect(at(4)).toBeNull()
      expect(at(5)).toBeNull()
      expect(at(6)).toBe("eee5555")
      expect(at(8)).toBe("eee5555")
    })

    const linkOf = async (sessionId: string, repoId: string) => {
      const [row] = await db
        .select({
          createdHere: sessionPullRequests.createdHere,
          title: pullRequests.title,
          number: pullRequests.number,
        })
        .from(sessionPullRequests)
        .innerJoin(pullRequests, eq(pullRequests.id, sessionPullRequests.prId))
        .where(eq(pullRequests.repoId, repoId))
      return row
    }

    test("a PR opened then merely referenced again stays marked as opened, while its mutable title updates", async () => {
      const sessionId = "sess-pr-or"
      await startSessionAt(sessionId)
      const repoId = await seedRepo("pr-or-repo")

      await pullRequestsRepo.upsertObserved(db, [
        { repoId, number: 59, sessionId, createdHere: true },
      ])
      await pullRequestsRepo.upsertObserved(db, [
        { repoId, number: 59, sessionId, createdHere: false, title: "feat: capture PRs" },
      ])

      // createdHere is OR-ed, never overwritten: authorship cannot be downgraded by a later read.
      expect(await linkOf(sessionId, repoId)).toEqual({
        createdHere: true,
        title: "feat: capture PRs",
        number: 59,
      })
    })

    test("a PR first seen as a reference and only later opened is promoted to opened", async () => {
      const sessionId = "sess-pr-promote"
      await startSessionAt(sessionId)
      const repoId = await seedRepo("pr-promote-repo")

      await pullRequestsRepo.upsertObserved(db, [
        { repoId, number: 77, sessionId, createdHere: false },
      ])
      await pullRequestsRepo.upsertObserved(db, [
        { repoId, number: 77, sessionId, createdHere: true },
      ])

      expect((await linkOf(sessionId, repoId))?.createdHere).toBe(true)
    })

    test("a re-observation carrying no title leaves the title already recorded intact", async () => {
      const sessionId = "sess-pr-title"
      await startSessionAt(sessionId)
      const repoId = await seedRepo("pr-title-repo")

      await pullRequestsRepo.upsertObserved(db, [
        { repoId, number: 12, sessionId, createdHere: false, title: "feat: first title" },
      ])
      await pullRequestsRepo.upsertObserved(db, [
        { repoId, number: 12, sessionId, createdHere: false },
      ])

      expect((await linkOf(sessionId, repoId))?.title).toBe("feat: first title")
    })
  })
})
