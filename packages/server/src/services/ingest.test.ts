import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import type { IngestPayload, NormalizedMessage, ParsedRecord, RepoIdentity } from "@samskara/core"
import { createLogger } from "@samskara/core"
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import { and, eq, inArray } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { type Db, createDb } from "../db/client.js"
import {
  commits,
  messages,
  projects,
  pullRequests,
  repos,
  sessionPullRequests,
  sessions,
  subagents,
  tokenUsage,
  toolCall,
  toolResult,
  users,
} from "../db/schema.js"
import { type Ctx, ingest } from "./ingest.js"

const dockerAvailable = () => {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

const packageDir = fileURLToPath(new URL("../..", import.meta.url))
const project = { name: "widget", slug: "acme-widget" } as const
const testLog = () => createLogger({ service: "test" }, { level: "silent" })

type TestMessage = {
  readonly lineUuid: string
  readonly lineNumber: number
  readonly message: NormalizedMessage
}

const customMessage = ({
  sessionId,
  lineUuid,
  lineNumber = 1,
  subIndex = 0,
}: {
  readonly sessionId: string
  readonly lineUuid: string
  readonly lineNumber?: number
  readonly subIndex?: number
}): TestMessage => ({
  lineUuid,
  lineNumber,
  message: {
    subIndex,
    sessionId,
    source: "claude_code",
    sourceSchemaVersion: 1,
    trackId: "main",
    msgType: "custom",
    subType: "fixture",
  },
})

const recordsFrom = (items: ReadonlyArray<TestMessage>): ReadonlyArray<ParsedRecord> => {
  const lineUuids = [...new Set(items.map((item) => item.lineUuid))]
  return lineUuids.map((lineUuid) => {
    const matching = items.filter((item) => item.lineUuid === lineUuid)
    const [first, ...rest] = matching.map((item) => item.message)
    if (!first) throw new Error("record requires messages")
    return {
      lineUuid,
      lineNumber: matching[0]?.lineNumber ?? 1,
      raw: { lineUuid, secret: "[Redacted]" },
      messages: [first, ...rest],
    }
  })
}

type SessionOrigin = { readonly startCwd?: string; readonly startCommit?: string }

const mainPayload = (
  sessionId: string,
  items: ReadonlyArray<TestMessage>,
  origin: SessionOrigin = {},
): IngestPayload => ({
  type: "main",
  sessionId,
  sourceRelativePath: `${sessionId}.jsonl`,
  project,
  records: recordsFrom(items),
  ...origin,
})

const subagentPayload = (
  sessionId: string,
  agentId: string,
  items: ReadonlyArray<TestMessage>,
): IngestPayload => ({
  type: "subagent",
  sessionId,
  sourceRelativePath: `${sessionId}/subagents/agent-${agentId}.jsonl`,
  project,
  agent: { agentId, agentType: "auditor", description: "fixture subagent" },
  records: recordsFrom(items),
})

describe.skipIf(!dockerAvailable())("ingest service", () => {
  let container: StartedPostgreSqlContainer
  let teardown: () => Promise<void>
  let db: Db
  let userId: string
  let ctx: Ctx

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
    const [user] = await db
      .insert(users)
      .values({ githubId: 9001, githubLogin: "ingest-user" })
      .returning()
    if (!user) throw new Error("seed user failed")
    userId = user.id
    ctx = { db, log: testLog(), userId }
    teardown = async () => {
      await created.client.end()
      await container.stop()
    }
  }, 120_000)

  afterAll(async () => {
    await teardown?.()
  })

  test("S8: canonical JSONB rows and projections round-trip with session-scoped deduplication", async () => {
    const sessionId = "sess-roundtrip"
    const lineUuid = "0191d942-3ba5-7dba-9a7d-22d65b3025a0"
    const base = {
      sessionId,
      source: "claude_code" as const,
      sourceSchemaVersion: 1,
      trackId: "main",
    }
    const items: ReadonlyArray<TestMessage> = [
      {
        lineUuid,
        lineNumber: 1,
        message: {
          ...base,
          subIndex: 0,
          msgType: "message",
          role: "assistant",
          content: { type: "text", value: "hello" },
          tokens: { input: 4, output: 3, cached: 2, thinking: 1 },
        },
      },
      {
        lineUuid,
        lineNumber: 1,
        message: {
          ...base,
          subIndex: 1,
          msgType: "toolCall",
          details: { callId: "call-1", name: "Read", input: { path: "a.ts" } },
        },
      },
      {
        lineUuid,
        lineNumber: 1,
        message: {
          ...base,
          subIndex: 2,
          msgType: "toolResult",
          details: { callId: "call-1", output: { ok: true }, status: "cancelled" },
        },
      },
    ]

    expect(await ingest(ctx, mainPayload(sessionId, items))).toEqual({ ingested: 3, deduped: 0 })
    expect(await ingest(ctx, mainPayload(sessionId, items))).toEqual({ ingested: 0, deduped: 3 })

    const rows = await db
      .select()
      .from(messages)
      .where(eq(messages.sessionId, sessionId))
      .orderBy(messages.subIndex)
    expect(rows).toHaveLength(3)
    expect(rows[0]).toMatchObject({
      content: { type: "text", value: "hello" },
      raw: { lineUuid, secret: "[Redacted]" },
      timestamp: null,
      sourceRelativePath: `${sessionId}.jsonl`,
      trackId: "main",
    })
    expect(rows[1]?.details).toEqual({ callId: "call-1", name: "Read", input: { path: "a.ts" } })
    expect(rows[2]?.details).toEqual({
      callId: "call-1",
      output: { ok: true },
      status: "cancelled",
    })

    const [call] = await db.select().from(toolCall).where(eq(toolCall.toolId, "call-1"))
    const [result] = await db.select().from(toolResult).where(eq(toolResult.toolId, "call-1"))
    const [tokens] = await db.select().from(tokenUsage).where(eq(tokenUsage.inputTokens, 4))
    expect(call?.toolInput).toEqual({ path: "a.ts" })
    expect(result).toMatchObject({ result: { ok: true }, status: "cancelled" })
    expect(tokens).toMatchObject({ outputTokens: 3, cachedTokens: 2, thinkingTokens: 1 })

    const otherSession = "sess-roundtrip-other"
    const otherItems = items.map((item) => ({
      ...item,
      message: { ...item.message, sessionId: otherSession },
    }))
    expect(await ingest(ctx, mainPayload(otherSession, otherItems))).toEqual({
      ingested: 3,
      deduped: 0,
    })
  })

  test("a subagent payload naming another user's session is refused, not attached to", async () => {
    // An aud:cli token is valid for ANY user's CLI installation, so proving a session exists
    // proves nothing about who may write to it. Without a userId-scoped check, one user's daemon
    // can inject fabricated subagent and message rows into another user's session by naming its id.
    const [victim] = await db
      .insert(users)
      .values({ githubId: 9002, githubLogin: "ingest-victim" })
      .returning()
    if (!victim) throw new Error("seed victim failed")
    const [victimProject] = await db
      .insert(projects)
      .values({ name: "victim", slug: "victim-proj", ownerId: victim.id })
      .returning()
    if (!victimProject) throw new Error("seed victim project failed")

    const victimSession = "sess-belongs-to-victim"
    await db.insert(sessions).values({
      id: victimSession,
      source: "claude_code",
      userId: victim.id,
      projectId: victimProject.id,
    })

    // `ctx` authenticates as ingest-user -- a different account from the session's owner.
    const item = customMessage({
      sessionId: victimSession,
      lineUuid: "0191d942-3ba5-7dba-9a7d-22d65b3025ff",
    })
    const attack = subagentPayload(victimSession, "evil", [
      { ...item, message: { ...item.message, agentId: "evil", trackId: "agent:evil" } },
    ])

    expect(await ingest(ctx, attack)).toEqual({ error: "sessionNotFound" })

    // Refused, not merely reported: nothing may reach the victim's session.
    expect(
      await db.select().from(subagents).where(eq(subagents.sessionId, victimSession)),
    ).toHaveLength(0)
    expect(
      await db.select().from(messages).where(eq(messages.sessionId, victimSession)),
    ).toHaveLength(0)
  })

  test("S6: a session whose messages span two repos records two distinct repoIds, and a message with no repo records none", async () => {
    const sessionId = "sess-two-repos"
    const serana: RepoIdentity = {
      host: "github.com",
      owner: "refrens",
      ownerType: "org",
      repoName: "serana",
    }
    const andromeda: RepoIdentity = { ...serana, repoName: "andromeda" }

    const withRepo = (lineUuid: string, lineNumber: number, repo?: RepoIdentity): TestMessage => {
      const base = customMessage({ sessionId, lineUuid, lineNumber })
      return { ...base, message: { ...base.message, ...(repo ? { repo } : {}) } }
    }

    expect(
      await ingest(
        ctx,
        mainPayload(sessionId, [
          withRepo("0191d942-3ba5-7dba-9a7d-0000000000a1", 1, serana),
          withRepo("0191d942-3ba5-7dba-9a7d-0000000000a2", 2, andromeda),
          withRepo("0191d942-3ba5-7dba-9a7d-0000000000a3", 3),
        ]),
      ),
    ).toEqual({ ingested: 3, deduped: 0 })

    const rows = await db
      .select({ lineNumber: messages.lineNumber, repoId: messages.repoId })
      .from(messages)
      .where(eq(messages.sessionId, sessionId))
      .orderBy(messages.lineNumber)

    const [first, second, third] = rows
    expect(first?.repoId).toBeTruthy()
    expect(second?.repoId).toBeTruthy()
    // Two repos, not one: a session that moves between checkouts is the whole point.
    expect(first?.repoId).not.toBe(second?.repoId)
    expect(third?.repoId).toBeNull()

    const repoRows = await db
      .select({ id: repos.id, repoName: repos.repoName })
      .from(repos)
      .where(inArray(repos.repoName, ["serana", "andromeda"]))
    expect(new Set(repoRows.map((r) => r.repoName))).toEqual(new Set(["serana", "andromeda"]))
    expect(new Set(repoRows.map((r) => r.id))).toEqual(new Set([first?.repoId, second?.repoId]))
  })

  test("S7: a payload whose messages carry no repo ingests with the same counts as before, and still stores gitBranch", async () => {
    const sessionId = "sess-no-repo"
    const base = customMessage({
      sessionId,
      lineUuid: "0191d942-3ba5-7dba-9a7d-0000000000b1",
    })
    const items: ReadonlyArray<TestMessage> = [
      { ...base, message: { ...base.message, gitBranch: "feat/capture" } },
    ]

    expect(await ingest(ctx, mainPayload(sessionId, items))).toEqual({ ingested: 1, deduped: 0 })
    expect(await ingest(ctx, mainPayload(sessionId, items))).toEqual({ ingested: 0, deduped: 1 })

    const [row] = await db
      .select({ gitBranch: messages.gitBranch, repoId: messages.repoId })
      .from(messages)
      .where(eq(messages.sessionId, sessionId))
    expect(row).toEqual({ gitBranch: "feat/capture", repoId: null })
  })

  test("S21: a session stores the cwd and sha it started at, and a later flush carrying neither leaves both unchanged", async () => {
    const sessionId = "sess-origin"
    const startCommit = "37f31013b7ac0a2e6f4c9d1e5a8b2c7d0e3f4a5b"

    await ingest(
      ctx,
      mainPayload(
        sessionId,
        [customMessage({ sessionId, lineUuid: "0191d942-3ba5-7dba-9a7d-000000000001" })],
        { startCwd: "/work/serana", startCommit },
      ),
    )

    const [created] = await db.select().from(sessions).where(eq(sessions.id, sessionId))
    expect(created).toMatchObject({ cwd: "/work/serana", startCommit })

    // A later flush of the same session sends no origin -- the sha it began at must survive it,
    // or every long session ends up recording only its most recent flush.
    await ingest(
      ctx,
      mainPayload(sessionId, [
        customMessage({
          sessionId,
          lineUuid: "0191d942-3ba5-7dba-9a7d-000000000002",
          lineNumber: 2,
        }),
      ]),
    )

    const [after] = await db.select().from(sessions).where(eq(sessions.id, sessionId))
    expect(after).toMatchObject({ cwd: "/work/serana", startCommit })
  })

  test("S22: a session started outside a git repo ingests with a startCwd but a null starting sha", async () => {
    const sessionId = "sess-origin-nongit"

    expect(
      await ingest(
        ctx,
        mainPayload(
          sessionId,
          [customMessage({ sessionId, lineUuid: "0191d942-3ba5-7dba-9a7d-000000000003" })],
          { startCwd: "/private/tmp/scratch" },
        ),
      ),
    ).toEqual({ ingested: 1, deduped: 0 })

    const [row] = await db.select().from(sessions).where(eq(sessions.id, sessionId))
    expect(row?.cwd).toBe("/private/tmp/scratch")
    expect(row?.startCommit).toBeNull()
  })

  const subRepo: RepoIdentity = {
    host: "github.com",
    owner: "refrens",
    ownerType: "org",
    repoName: "serana",
  }
  const projectRepo: RepoIdentity = { ...subRepo, repoName: "andromeda" }

  /**
   * A session whose project root is one repo and whose commit ran in a sub-repo inside it --
   * the case that forces a commit's repo to come from the calling message's own cwd.
   */
  const commitPayload = (sessionId: string, sha = "37f3101"): IngestPayload => {
    const callLine = "0191d942-3ba5-7dba-9a7d-0000000000c1"
    const call = customMessage({ sessionId, lineUuid: callLine, lineNumber: 1 })
    const root = customMessage({
      sessionId,
      lineUuid: "0191d942-3ba5-7dba-9a7d-0000000000c0",
      lineNumber: 2,
    })
    return {
      ...mainPayload(sessionId, [
        {
          ...call,
          message: {
            ...call.message,
            msgType: "toolCall",
            details: { callId: "call-commit", name: "Bash", input: { command: "git commit" } },
            repo: subRepo,
          } as NormalizedMessage,
        },
        { ...root, message: { ...root.message, repo: projectRepo } },
      ]),
      gitEvents: [
        {
          kind: "commit",
          sha,
          branch: "feat/local-source-graph",
          subject: "docs: enrich clients",
          filesChanged: 51,
          insertions: 1993,
          deletions: 417,
          repo: subRepo,
          callId: "call-commit",
        },
      ],
    }
  }

  test("S13: a commit is recorded against the repo of the cwd it ran in and points at the message that made it", async () => {
    const sessionId = "sess-commit-attribution"
    expect(await ingest(ctx, commitPayload(sessionId))).toMatchObject({ ingested: 2 })

    const [row] = await db
      .select({
        sha: commits.sha,
        branch: commits.branch,
        subject: commits.subject,
        filesChanged: commits.filesChanged,
        insertions: commits.insertions,
        deletions: commits.deletions,
        repoId: commits.repoId,
        messageId: commits.messageId,
        sessionId: commits.sessionId,
      })
      .from(commits)
      .where(eq(commits.sessionId, sessionId))

    expect(row).toMatchObject({
      sha: "37f3101",
      branch: "feat/local-source-graph",
      subject: "docs: enrich clients",
      filesChanged: 51,
      insertions: 1993,
      deletions: 417,
      sessionId,
    })

    const [serana] = await db
      .select({ id: repos.id })
      .from(repos)
      .where(and(eq(repos.repoName, "serana"), eq(repos.owner, "refrens")))
    const [andromeda] = await db
      .select({ id: repos.id })
      .from(repos)
      .where(and(eq(repos.repoName, "andromeda"), eq(repos.owner, "refrens")))

    // The sub-repo the Bash call ran in, not the project root's repo.
    expect(row?.repoId).toBe(serana?.id)
    expect(row?.repoId).not.toBe(andromeda?.id)

    const [caller] = await db
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.sessionId, sessionId), eq(messages.msgType, "toolCall")))
    expect(row?.messageId).toBe(caller?.id)
  })

  test("S14: re-ingesting the same commit leaves exactly one unchanged row", async () => {
    const sessionId = "sess-commit-reingest"
    await ingest(ctx, commitPayload(sessionId, "9e4b1c7"))
    const before = await db.select().from(commits).where(eq(commits.sessionId, sessionId))

    await ingest(ctx, commitPayload(sessionId, "9e4b1c7"))
    const after = await db.select().from(commits).where(eq(commits.sessionId, sessionId))

    expect(after).toHaveLength(1)
    expect(after).toEqual(before)
  })

  const prPayload = (
    sessionId: string,
    event: {
      readonly number: number
      readonly createdHere: boolean
      readonly repoName?: string
      readonly title?: string
      readonly lineUuid: string
    },
  ): IngestPayload => {
    const call = customMessage({ sessionId, lineUuid: event.lineUuid, lineNumber: 1 })
    return {
      ...mainPayload(sessionId, [
        {
          ...call,
          message: {
            ...call.message,
            msgType: "toolCall",
            details: { callId: "call-pr", name: "Bash", input: { command: "gh pr create" } },
          } as NormalizedMessage,
        },
      ]),
      gitEvents: [
        {
          kind: "pullRequest",
          host: "github.com",
          owner: "vertexcover-io",
          repoName: event.repoName ?? "harness-engineering",
          number: event.number,
          ...(event.title ? { title: event.title } : {}),
          createdHere: event.createdHere,
          callId: "call-pr",
        },
      ],
    }
  }

  const prRowsFor = (sessionId: string) =>
    db
      .select({
        number: pullRequests.number,
        title: pullRequests.title,
        repoName: repos.repoName,
        host: repos.host,
        owner: repos.owner,
        createdHere: sessionPullRequests.createdHere,
        messageId: sessionPullRequests.messageId,
      })
      .from(sessionPullRequests)
      .innerJoin(pullRequests, eq(pullRequests.id, sessionPullRequests.prId))
      .innerJoin(repos, eq(repos.id, pullRequests.repoId))
      .where(eq(sessionPullRequests.sessionId, sessionId))

  test("S15b: a PR opened by the session lands against the repo its own url named, linked to the message that opened it", async () => {
    const sessionId = "sess-pr-created"
    await ingest(
      ctx,
      prPayload(sessionId, {
        number: 59,
        createdHere: true,
        lineUuid: "0191d942-3ba5-7dba-9a7d-0000000000d1",
      }),
    )

    const rows = await prRowsFor(sessionId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      number: 59,
      host: "github.com",
      owner: "vertexcover-io",
      repoName: "harness-engineering",
      createdHere: true,
    })

    const [caller] = await db
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.sessionId, sessionId), eq(messages.msgType, "toolCall")))
    expect(rows[0]?.messageId).toBe(caller?.id)
  })

  test("S19: a session that opens a PR then re-reads it keeps one row still marked as opened", async () => {
    const sessionId = "sess-pr-created-then-viewed"
    await ingest(
      ctx,
      prPayload(sessionId, {
        number: 77,
        createdHere: true,
        lineUuid: "0191d942-3ba5-7dba-9a7d-0000000000d2",
      }),
    )
    await ingest(
      ctx,
      prPayload(sessionId, {
        number: 77,
        createdHere: false,
        title: "feat: capture pull requests",
        lineUuid: "0191d942-3ba5-7dba-9a7d-0000000000d3",
      }),
    )

    const rows = await prRowsFor(sessionId)
    expect(rows).toHaveLength(1)
    // The later reference updates the mutable title but must never downgrade authorship.
    expect(rows[0]).toMatchObject({
      number: 77,
      createdHere: true,
      title: "feat: capture pull requests",
    })
  })

  test("S20: a session working across two repos attributes each of its commits to the checkout it was made in, and lists both repos as touched", async () => {
    const sessionId = "sess-two-repo-acceptance"
    const birds: RepoIdentity = {
      host: "github.com",
      owner: "refrens",
      ownerType: "org",
      repoName: "birds",
    }
    const talos: RepoIdentity = { ...birds, repoName: "talos" }

    const inRepo = (
      lineUuid: string,
      lineNumber: number,
      callId: string,
      repo: RepoIdentity,
    ): TestMessage => {
      const base = customMessage({ sessionId, lineUuid, lineNumber })
      return {
        ...base,
        message: {
          ...base.message,
          msgType: "toolCall",
          details: { callId, name: "Bash", input: { command: "git commit" } },
          repo,
        } as NormalizedMessage,
      }
    }

    await ingest(ctx, {
      ...mainPayload(sessionId, [
        inRepo("0191d942-3ba5-7dba-9a7d-0000000000e1", 1, "call-birds", birds),
        inRepo("0191d942-3ba5-7dba-9a7d-0000000000e2", 2, "call-talos", talos),
      ]),
      gitEvents: [
        {
          kind: "commit",
          sha: "b1rd5aa",
          branch: "feat/birds",
          subject: "feat: birds work",
          repo: birds,
          callId: "call-birds",
        },
        {
          kind: "commit",
          sha: "ta105bb",
          branch: "feat/talos",
          subject: "feat: talos work",
          repo: talos,
          callId: "call-talos",
        },
      ],
    })

    const rows = await db
      .select({ sha: commits.sha, repoName: repos.repoName, repoId: commits.repoId })
      .from(commits)
      .innerJoin(repos, eq(repos.id, commits.repoId))
      .where(eq(commits.sessionId, sessionId))

    expect(rows).toHaveLength(2)
    expect(new Set(rows.map((row) => `${row.sha}:${row.repoName}`))).toEqual(
      new Set(["b1rd5aa:birds", "ta105bb:talos"]),
    )
    // Two distinct repos, not one shared attribution.
    expect(new Set(rows.map((row) => row.repoId)).size).toBe(2)

    const touched = await db
      .selectDistinct({ repoName: repos.repoName })
      .from(messages)
      .innerJoin(repos, eq(repos.id, messages.repoId))
      .where(eq(messages.sessionId, sessionId))
    expect(new Set(touched.map((row) => row.repoName))).toEqual(new Set(["birds", "talos"]))
  })

  test("a PR naming a repo the session never had a cwd in still creates that repo", async () => {
    const sessionId = "sess-pr-unvisited-repo"
    await ingest(
      ctx,
      prPayload(sessionId, {
        number: 391,
        createdHere: false,
        repoName: "birds",
        lineUuid: "0191d942-3ba5-7dba-9a7d-0000000000d4",
      }),
    )

    const rows = await prRowsFor(sessionId)
    expect(rows[0]).toMatchObject({ repoName: "birds", number: 391, createdHere: false })

    const [row] = await db
      .select({ repoId: messages.repoId })
      .from(messages)
      .where(eq(messages.sessionId, sessionId))
    // No message carried a repo, so the repo exists only because the PR's URL named it.
    expect(row?.repoId).toBeNull()
  })
})
