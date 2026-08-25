import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import { and, eq } from "drizzle-orm"
import { type MigrationMeta, readMigrationFiles } from "drizzle-orm/migrator"
import postgres from "postgres"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { z } from "zod"
import * as messagesRepo from "../repositories/messages.repo.js"
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
  subagents,
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

let messageLineNumber = 0
const messageRow = (
  sessionId: string,
  timestamp: Date | null,
  overrides: Partial<messagesRepo.MessageRow> = {},
): messagesRepo.MessageRow => {
  messageLineNumber += 1
  return {
    sessionId,
    lineUuid: randomUUID(),
    subIndex: 0,
    msgType: "message",
    lineNumber: messageLineNumber,
    raw: {},
    sourceSchemaVersion: 1,
    timestamp,
    ...overrides,
  }
}

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
      .values(messageRow(sessionId, null, { repoId }))
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

  const activityOf = async (sessionId: string) => {
    const [row] = await db.select().from(sessions).where(eq(sessions.id, sessionId))
    if (!row) throw new Error("session missing")
    return row
  }

  test("SC1, SC2: inserting messages sets startedAt to the earliest and lastMessageAt to the latest timestamp, leaving createdAt unchanged", async () => {
    const session = await seedSession("sess-sc1")
    const early = new Date("2026-01-01T10:00:00Z")
    const late = new Date("2026-01-01T10:05:00Z")

    await messagesRepo.insertManyIgnoreConflicts(db, session.id, [
      messageRow(session.id, late),
      messageRow(session.id, early),
    ])

    const row = await activityOf(session.id)
    expect(row.startedAt?.getTime()).toBe(early.getTime())
    expect(row.lastMessageAt?.getTime()).toBe(late.getTime())
    expect(row.createdAt.getTime()).toBe(session.createdAt.getTime())
  })

  const windowStart = new Date("2026-02-01T10:00:00Z")
  const windowEnd = new Date("2026-02-01T11:00:00Z")
  const at = (iso: string) => new Date(iso)
  type SecondBatch = ReadonlyArray<readonly [Date | null, Partial<messagesRepo.MessageRow>?]>
  test.each<readonly [string, SecondBatch, Date, Date]>([
    [
      "SC3: a second insert reaching earlier and later than the window widens it both ways",
      [[at("2026-02-01T09:00:00Z")], [at("2026-02-01T12:00:00Z")]],
      at("2026-02-01T09:00:00Z"),
      at("2026-02-01T12:00:00Z"),
    ],
    [
      "SC4: a second insert inside the window leaves it unchanged",
      [[at("2026-02-01T10:30:00Z")]],
      windowStart,
      windowEnd,
    ],
    [
      "SC6: a second insert with no timestamps leaves it unchanged",
      [[null]],
      windowStart,
      windowEnd,
    ],
    [
      "SC7: a subagent flush past the end moves lastMessageAt to its latest message",
      [[at("2026-02-01T12:00:00Z"), { isSubagent: true, agentId: "agent-sc7" }]],
      windowStart,
      at("2026-02-01T12:00:00Z"),
    ],
  ])("%s", async (name, second, expectedStart, expectedEnd) => {
    const session = await seedSession(`sess-${name.slice(0, 3).toLowerCase()}`)
    await messagesRepo.insertManyIgnoreConflicts(db, session.id, [
      messageRow(session.id, windowStart),
      messageRow(session.id, windowEnd),
    ])

    await messagesRepo.insertManyIgnoreConflicts(
      db,
      session.id,
      second.map(([timestamp, overrides]) => messageRow(session.id, timestamp, overrides)),
    )

    const row = await activityOf(session.id)
    expect(row.startedAt?.getTime()).toBe(expectedStart.getTime())
    expect(row.lastMessageAt?.getTime()).toBe(expectedEnd.getTime())
  })

  test("SC9: one insert covering two sessions gives each its own start and end", async () => {
    const sessionA = await seedSession("sess-sc9-a")
    const sessionB = await seedSession("sess-sc9-b")
    const aEarly = new Date("2026-02-04T09:00:00Z")
    const aLate = new Date("2026-02-04T09:30:00Z")
    const bEarly = new Date("2026-02-04T14:00:00Z")
    const bLate = new Date("2026-02-04T15:00:00Z")

    await messagesRepo.insertManyIgnoreConflicts(db, sessionA.id, [
      messageRow(sessionA.id, aEarly),
      messageRow(sessionA.id, aLate),
      messageRow(sessionB.id, bEarly),
      messageRow(sessionB.id, bLate),
    ])

    const rowA = await activityOf(sessionA.id)
    const rowB = await activityOf(sessionB.id)
    expect(rowA.startedAt?.getTime()).toBe(aEarly.getTime())
    expect(rowA.lastMessageAt?.getTime()).toBe(aLate.getTime())
    expect(rowB.startedAt?.getTime()).toBe(bEarly.getTime())
    expect(rowB.lastMessageAt?.getTime()).toBe(bLate.getTime())
  })

  test("SC10: an activity write leaves a session's updatedAt exactly where it was", async () => {
    const session = await seedSession("sess-sc10")
    // Two statements, so now() differs between them: a masking bug shows as updatedAt jumping forward.
    const before = await activityOf(session.id)

    await messagesRepo.insertManyIgnoreConflicts(db, session.id, [
      messageRow(session.id, new Date("2026-02-08T09:00:00Z")),
    ])

    const after = await activityOf(session.id)
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime())
    expect(after.startedAt).not.toBeNull()
  })

  test("SC11, SC12 (regression): every table carrying updatedAt advances it on an edit to its own row, leaving createdAt alone", async () => {
    const { user, project } = await seed()
    const [org] = await db
      .insert(orgs)
      .values({ githubSlug: `org-sc12-${seedCounter}` })
      .returning()
    const repo = await seedRepo(user.id, `repo-sc12-${seedCounter}`)
    const session = await seedSession(`sess-sc12-${seedCounter}`)
    const [subagent] = await db
      .insert(subagents)
      .values({ agentId: "agent-sc12", sessionId: session.id, sourceRelativePath: "sub.jsonl" })
      .returning()
    if (!org || !subagent) throw new Error("seed returned no row")

    type Stamped = { readonly createdAt: Date; readonly updatedAt: Date }
    const edits: ReadonlyArray<readonly [Stamped, Promise<ReadonlyArray<Stamped>>]> = [
      [user, db.update(users).set({ name: "renamed" }).where(eq(users.id, user.id)).returning()],
      [org, db.update(orgs).set({ name: "renamed" }).where(eq(orgs.id, org.id)).returning()],
      [repo, db.update(repos).set({ owner: "renamed" }).where(eq(repos.id, repo.id)).returning()],
      [
        project,
        db.update(projects).set({ name: "renamed" }).where(eq(projects.id, project.id)).returning(),
      ],
      [
        session,
        db
          .update(sessions)
          .set({ title: "renamed" })
          .where(eq(sessions.id, session.id))
          .returning(),
      ],
      [
        subagent,
        db
          .update(subagents)
          .set({ description: "renamed" })
          .where(and(eq(subagents.sessionId, session.id), eq(subagents.agentId, subagent.agentId)))
          .returning(),
      ],
    ]

    for (const [before, edit] of edits) {
      const [after] = await edit
      if (!after) throw new Error("update returned no row")
      expect(after.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime())
      expect(after.createdAt.getTime()).toBe(before.createdAt.getTime())
    }
  })
})

describe.skipIf(!dockerAvailable())("0020 migration backfills existing sessions", () => {
  let container: StartedPostgreSqlContainer
  let client: postgres.Sql

  const migrationsFolder = fileURLToPath(new URL("../../migrations", import.meta.url))
  const TARGET = "0020_session_activity_times"
  // drizzle's own reader: journal order, each file already split at its breakpoints.
  const migrations = readMigrationFiles({ migrationsFolder })
  const journal = z
    .object({ entries: z.array(z.object({ tag: z.string() })) })
    .parse(JSON.parse(readFileSync(join(migrationsFolder, "meta/_journal.json"), "utf8")))
  const targetIndex = journal.entries.findIndex((entry) => entry.tag === TARGET)
  const target = migrations[targetIndex]
  if (!target) throw new Error(`${TARGET} is not in the migration journal`)

  const apply = async (migration: MigrationMeta) => {
    for (const statement of migration.sql) await client.unsafe(statement)
  }

  const sessionWithMessages = "sess-premigration-with-messages"
  const sessionWithoutMessages = "sess-premigration-without-messages"
  const earliest = new Date("2026-01-01T09:00:00Z")
  const latest = new Date("2026-01-01T12:00:00Z")
  let updatedAtBefore: ReadonlyMap<string, number>

  type SessionTimes = {
    readonly id: string
    readonly startedAt: Date | null
    readonly lastMessageAt: Date | null
    readonly updatedAt: Date
  }
  const sessionTimes = () =>
    client<SessionTimes[]>`select id, "startedAt", "lastMessageAt", "updatedAt" from sessions`

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg16").start()
    // A plain client, not createDb's: drizzle strips postgres.js's date parsers and serializers
    // from the client it wraps, so raw queries through it neither take nor return a Date.
    client = postgres(container.getConnectionUri(), { max: 1 })

    // Everything before the target by hand, seed on that schema, then the target alone: what is
    // under test is the backfill in that one file, not a fresh database that already has the
    // columns. Raw SQL throughout, because drizzle's builders spell today's schema.ts against a
    // database frozen here.
    for (const migration of migrations.slice(0, targetIndex)) await apply(migration)

    const [user] = await client<{ readonly id: string }[]>`
      insert into users ("githubId", "githubLogin") values (55001, 'pre-migration-user') returning id
    `
    if (!user) throw new Error("seed user failed")
    const [project] = await client<{ readonly id: string }[]>`
      insert into projects (name, slug, "ownerId") values ('pre', 'pre-migration', ${user.id}) returning id
    `
    if (!project) throw new Error("seed project failed")
    await client`
      insert into sessions (id, source, "userId", "projectId") values
        (${sessionWithMessages}, 'claude_code', ${user.id}, ${project.id}),
        (${sessionWithoutMessages}, 'claude_code', ${user.id}, ${project.id})
    `
    await client`
      insert into messages ("sessionId", "lineUuid", "subIndex", "msgType", "lineNumber", raw, "sourceSchemaVersion", timestamp) values
        (${sessionWithMessages}, ${randomUUID()}, 0, 'message', 1, '{}', 1, ${latest}),
        (${sessionWithMessages}, ${randomUUID()}, 0, 'message', 2, '{}', 1, ${earliest})
    `
    const before = await client<{ readonly id: string; readonly updatedAt: Date }[]>`
      select id, "updatedAt" from sessions
    `
    updatedAtBefore = new Map(before.map((row) => [row.id, row.updatedAt.getTime()]))

    await apply(target)
  }, 120_000)

  afterAll(async () => {
    await client?.end()
    await container?.stop()
  })

  test("SC13: existing sessions are backfilled from their stored messages, and one with none keeps null", async () => {
    const byId = new Map((await sessionTimes()).map((row) => [row.id, row]))

    expect(byId.get(sessionWithMessages)?.startedAt?.getTime()).toBe(earliest.getTime())
    expect(byId.get(sessionWithMessages)?.lastMessageAt?.getTime()).toBe(latest.getTime())
    expect(byId.get(sessionWithoutMessages)?.startedAt).toBeNull()
    expect(byId.get(sessionWithoutMessages)?.lastMessageAt).toBeNull()
  })

  test("SC14: the backfill leaves every session's updatedAt untouched", async () => {
    const after = await sessionTimes()
    expect(after).toHaveLength(2)
    for (const row of after) {
      expect(row.updatedAt.getTime()).toBe(updatedAtBefore.get(row.id))
    }
  })
})
