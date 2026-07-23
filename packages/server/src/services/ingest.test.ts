import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import type { IngestPayload, NormalizedMessage } from "@samskara/core"
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import { and, eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { type Db, createDb } from "../db/client.js"
import { messages, orgRepos, orgs, subagents, toolCall, toolResult, users } from "../db/schema.js"
import { ingest } from "./ingest.js"

const dockerAvailable = () => {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

const packageDir = fileURLToPath(new URL("../..", import.meta.url))

const repo = { host: "github", owner: "acme", ownerType: "user", repoName: "widget" } as const

const message = (
  over: Partial<NormalizedMessage> & Pick<NormalizedMessage, "lineUuid">,
): NormalizedMessage => ({
  subIndex: 0,
  sessionId: "s",
  source: "claude_code",
  sourceSchemaVersion: 1,
  msgType: "assistant",
  timestamp: "2026-07-23T00:00:00.000Z",
  lineNumber: 1,
  ...over,
})

const mainPayload = (sessionId: string, msgs: ReadonlyArray<NormalizedMessage>): IngestPayload => ({
  type: "main",
  sessionId,
  sourceRelativePath: `${sessionId}.jsonl`,
  repo,
  session: { model: "claude-opus-4-8", title: "hello" },
  rawLines: [...new Set(msgs.map((m) => m.lineUuid))].map((lineUuid) => ({ lineUuid, raw: "{}" })),
  messages: msgs,
})

describe.skipIf(!dockerAvailable())("ingest service", () => {
  let container: StartedPostgreSqlContainer
  let teardown: () => Promise<void>
  let db: Db
  let userId: string

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
    teardown = async () => {
      await created.client.end()
      await container.stop()
    }
  }, 120_000)

  afterAll(async () => {
    await teardown?.()
  })

  test("main flush creates session, grants repo, inserts fanned-out messages", async () => {
    const msgs = [
      message({ lineUuid: "l1", subIndex: 0, msgType: "assistant", content: "hi" }),
      message({
        lineUuid: "l1",
        subIndex: 1,
        msgType: "toolCall",
        toolCall: { id: "toolu_1", name: "Read", input: { path: "x" } },
      }),
      message({
        lineUuid: "l1",
        subIndex: 2,
        msgType: "toolResult",
        toolResult: { callId: "toolu_1", output: "ok", status: "success" },
      }),
    ]
    const result = await ingest(db, userId, mainPayload("sess-main", msgs))
    expect(result).toEqual({ ingested: 3, deduped: 0 })

    const rows = await db.select().from(messages).where(eq(messages.sessionId, "sess-main"))
    expect(rows).toHaveLength(3)

    const [call] = await db.select().from(toolCall).where(eq(toolCall.toolId, "toolu_1"))
    expect(call?.toolName).toBe("Read")
    const [res] = await db.select().from(toolResult).where(eq(toolResult.toolId, "toolu_1"))
    expect(res?.status).toBe("success")
  })

  test("re-ingest identical flush dedupes and does not duplicate tool rows", async () => {
    const msgs = [
      message({
        lineUuid: "l1",
        subIndex: 1,
        msgType: "toolCall",
        toolCall: { id: "toolu_1", name: "Read", input: { path: "x" } },
      }),
    ]
    const result = await ingest(db, userId, mainPayload("sess-main", msgs))
    expect(result).toEqual({ ingested: 0, deduped: 1 })

    const calls = await db.select().from(toolCall).where(eq(toolCall.toolId, "toolu_1"))
    expect(calls).toHaveLength(1)
  })

  test("subagent flush without session returns sessionNotFound and writes nothing", async () => {
    const payload: IngestPayload = {
      type: "subagent",
      sessionId: "ghost-session",
      sourceRelativePath: "subagents/agent-x.jsonl",
      repo,
      agent: { agentId: "agent-x", agentType: "Explore" },
      rawLines: [{ lineUuid: "g1", raw: "{}" }],
      messages: [message({ lineUuid: "g1", agentId: "agent-x" })],
    }
    const result = await ingest(db, userId, payload)
    expect(result).toEqual({ error: "sessionNotFound" })

    const subs = await db.select().from(subagents).where(eq(subagents.sessionId, "ghost-session"))
    expect(subs).toHaveLength(0)
    const msgs = await db.select().from(messages).where(eq(messages.sessionId, "ghost-session"))
    expect(msgs).toHaveLength(0)
  })

  test("subagent flush after main creates subagent row (I5)", async () => {
    await ingest(db, userId, mainPayload("sess-sub", [message({ lineUuid: "m1" })]))
    const payload: IngestPayload = {
      type: "subagent",
      sessionId: "sess-sub",
      sourceRelativePath: "subagents/agent-y.jsonl",
      repo,
      agent: { agentId: "agent-y", agentType: "fork" },
      rawLines: [{ lineUuid: "y1", raw: "{}" }],
      messages: [message({ lineUuid: "y1", agentId: "agent-y" })],
    }
    const result = await ingest(db, userId, payload)
    expect(result).toEqual({ ingested: 1, deduped: 0 })
    const [sub] = await db.select().from(subagents).where(eq(subagents.agentId, "agent-y"))
    expect(sub?.agentType).toBe("fork")
  })

  test("org repo links to a seeded org; still grants userRepo", async () => {
    const [org] = await db
      .insert(orgs)
      .values({ githubSlug: "acme-org", githubOrgId: 77 })
      .returning()
    if (!org) throw new Error("seed org failed")

    const orgPayload: IngestPayload = {
      ...mainPayload("sess-org", [message({ lineUuid: "o1" })]),
      repo: { host: "github", owner: "acme-org", ownerType: "org", repoName: "andromeda" },
    }
    await ingest(db, userId, orgPayload)

    const links = await db.select().from(orgRepos).where(eq(orgRepos.orgId, org.id))
    expect(links).toHaveLength(1)
  })

  test("resolves parentAgentId across flushes (I4)", async () => {
    await ingest(db, userId, mainPayload("sess-nest", [message({ lineUuid: "n1" })]))

    const parentFlush: IngestPayload = {
      type: "subagent",
      sessionId: "sess-nest",
      sourceRelativePath: "subagents/agent-parent.jsonl",
      repo,
      agent: { agentId: "agent-parent", spawnDepth: 1 },
      rawLines: [{ lineUuid: "p1", raw: "{}" }],
      messages: [
        message({
          lineUuid: "p1",
          subIndex: 0,
          msgType: "toolCall",
          agentId: "agent-parent",
          toolCall: { id: "toolu_spawn", name: "Task", input: {} },
        }),
      ],
    }
    await ingest(db, userId, parentFlush)

    const childFlush: IngestPayload = {
      type: "subagent",
      sessionId: "sess-nest",
      sourceRelativePath: "subagents/agent-child.jsonl",
      repo,
      agent: { agentId: "agent-child", spawnDepth: 2, spawnToolUseId: "toolu_spawn" },
      rawLines: [{ lineUuid: "c1", raw: "{}" }],
      messages: [message({ lineUuid: "c1", agentId: "agent-child" })],
    }
    await ingest(db, userId, childFlush)

    const [child] = await db
      .select()
      .from(subagents)
      .where(and(eq(subagents.sessionId, "sess-nest"), eq(subagents.agentId, "agent-child")))
    expect(child?.parentAgentId).toBe("agent-parent")
  })
})
