import { randomUUID } from "node:crypto"
import { and, eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import * as messagesRepo from "../repositories/messages.repo.js"
import * as sessionsRepo from "../repositories/sessions.repo.js"
import type { Db } from "./client.js"
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
import { dockerAvailable, startTestDb } from "./testDb.js"

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
  let teardown: () => Promise<void>
  let db: Db

  beforeAll(async () => {
    const started = await startTestDb()
    db = started.db
    teardown = started.teardown
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
    const started = await startTestDb()
    db = started.db
    teardown = started.teardown
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
      .values({ host: "github.com", owner: "acme", repoName, ownerUserId: userId })
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

  test("SC6: deleting a repo keeps its messages and clears their repo pointer", async () => {
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
