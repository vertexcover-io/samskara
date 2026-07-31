import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import type { IngestPayload, NormalizedMessage, ParsedRecord } from "@samskara/core"
import { createLogger } from "@samskara/core"
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import { and, eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { type Db, createDb } from "../db/client.js"
import {
  messages,
  projects,
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

const mainPayload = (sessionId: string, items: ReadonlyArray<TestMessage>): IngestPayload => ({
  type: "main",
  sessionId,
  sourceRelativePath: `${sessionId}.jsonl`,
  project,
  records: recordsFrom(items),
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
})
