import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, rename, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import type { CheckpointStore, FileSystem, IngestPayload } from "@samskara/core"
import { createClaudePlugin, createLogger } from "@samskara/core"
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { buildApp } from "../app.js"
import { createDb, type Db } from "../db/client.js"
import {
  messages,
  orgs,
  projects,
  sessions,
  subagents,
  tokenUsage,
  toolCall,
  toolResult,
  userOrgs,
  users,
} from "../db/schema.js"
import type { Env } from "../lib/env.js"
import { signToken } from "../lib/jwt.js"
import { captureLogger } from "../lib/test-logger.js"
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

const fixturePath = fileURLToPath(new URL("./__fixtures__/real-session.jsonl", import.meta.url))

const env: Env = {
  githubClientId: "id",
  githubClientSecret: "secret",
  publicBaseUrl: "http://localhost:3000",
  webBaseUrl: "http://localhost:8000",
  cookieSecure: false,
  jwtSecret: "test-secret-value",
  jwtExpiresIn: "7d",
  superAdminLogins: [],
}

const project = { name: "widget", slug: "acme-widget" } as const
const nodeFs: FileSystem = {
  readFile: (path) => readFile(path, "utf8"),
  writeFile: (path, data) => writeFile(path, data, "utf8"),
  rename,
  stat: async (path) => {
    const value = await stat(path)
    return { size: value.size, mtimeMs: value.mtimeMs }
  },
}

type CoverageTrack = {
  readonly sourceRelativePath: string
  readonly sourceLineCount: number
  readonly parsedRecordCount: number
}

const isCoverageTrack = (value: unknown): value is CoverageTrack =>
  typeof value === "object" &&
  value !== null &&
  "sourceRelativePath" in value &&
  typeof value.sourceRelativePath === "string" &&
  "sourceLineCount" in value &&
  typeof value.sourceLineCount === "number" &&
  "parsedRecordCount" in value &&
  typeof value.parsedRecordCount === "number"

const mainPayload = (
  sessionId: string,
  overrideProject: IngestPayload["project"] = project,
): IngestPayload => ({
  type: "main",
  sessionId,
  sourceRelativePath: `${sessionId}.jsonl`,
  project: overrideProject,
  title: "hello",
  records: [
    {
      lineUuid: "0191d942-3ba5-7dba-9a7d-22d65b30258c",
      lineNumber: 1,
      raw: {},
      messages: [
        {
          subIndex: 0,
          sessionId,
          source: "claude_code",
          sourceSchemaVersion: 1,
          trackId: "main",
          msgType: "message",
          role: "assistant",
          timestamp: "2026-07-23T00:00:00.000Z",
          content: { type: "text", value: "hi" },
        },
      ],
    },
  ],
})

const subagentPayload = (sessionId: string): IngestPayload => ({
  type: "subagent",
  sessionId,
  sourceRelativePath: `subagents/${sessionId}.jsonl`,
  project,
  agent: { agentId: "agent-z" },
  records: [
    {
      lineUuid: "0191d942-3ba5-7dba-9a7d-22d65b30258e",
      lineNumber: 1,
      raw: {},
      messages: [
        {
          subIndex: 0,
          sessionId,
          source: "claude_code",
          sourceSchemaVersion: 1,
          trackId: "agent:agent-z",
          msgType: "custom",
          subType: "fixture",
          timestamp: "2026-07-23T00:00:00.000Z",
          agentId: "agent-z",
        },
      ],
    },
  ],
})

const post = (app: ReturnType<typeof buildApp>, payload: unknown, token?: string) =>
  app.request("/api/ingest", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(payload),
  })

describe.skipIf(!dockerAvailable())("ingest route", () => {
  let container: StartedPostgreSqlContainer
  let teardown: () => Promise<void>
  let db: Db
  let app: ReturnType<typeof buildApp>
  let cliToken: string
  let routeUserId: string

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
      .values({ githubId: 4242, githubLogin: "route-user" })
      .returning()
    if (!user) throw new Error("seed user failed")
    routeUserId = user.id
    cliToken = await signToken(env, { sub: user.id, aud: "cli" })
    app = buildApp(db, env, {
      githubClient: {
        exchangeCode: async () => ({ accessToken: "x" }),
        getProfile: async () => ({ githubId: 1, login: "x" }),
        getOrgs: async () => [],
        getVerifiedEmails: async () => [],
      },
      rootLog: createLogger({ service: "test" }, { level: "silent" }),
    })
    teardown = async () => {
      await created.client.end()
      await container.stop()
    }
  }, 120_000)

  afterAll(async () => {
    await teardown?.()
  })

  test("rejects a request with no token (401)", async () => {
    const res = await post(app, mainPayload("sess-401"))
    expect(res.status).toBe(401)
  })

  test("rejects a web-audience token (401)", async () => {
    const webToken = await signToken(env, { sub: "someone", aud: "web" })
    const res = await post(app, mainPayload("sess-web"), webToken)
    expect(res.status).toBe(401)
  })

  test("rejects a malformed body (400)", async () => {
    const res = await post(app, { type: "main", sessionId: "x" }, cliToken)
    expect(res.status).toBe(400)
  })

  test("accepts a valid main flush (200) and persists rows", async () => {
    const res = await post(app, mainPayload("sess-ok"), cliToken)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ingested: 1, deduped: 0 })

    const rows = await db.select().from(messages).where(eq(messages.sessionId, "sess-ok"))
    expect(rows).toHaveLength(1)
  })

  test("returns 409 for a subagent flush with no session", async () => {
    const payload: IngestPayload = {
      type: "subagent",
      sessionId: "no-session",
      sourceRelativePath: "subagents/agent-z.jsonl",
      project,
      agent: { agentId: "agent-z" },
      records: [
        {
          lineUuid: "0191d942-3ba5-7dba-9a7d-22d65b30258d",
          lineNumber: 1,
          raw: {},
          messages: [
            {
              subIndex: 0,
              sessionId: "no-session",
              source: "claude_code",
              sourceSchemaVersion: 1,
              trackId: "agent:agent-z",
              msgType: "custom",
              subType: "fixture",
              timestamp: "2026-07-23T00:00:00.000Z",
              agentId: "agent-z",
            },
          ],
        },
      ],
    }
    const res = await post(app, payload, cliToken)
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: "sessionNotFound" })
  })

  test("idempotent re-POST dedupes (200)", async () => {
    await post(app, mainPayload("sess-dupe"), cliToken)
    const res = await post(app, mainPayload("sess-dupe"), cliToken)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ingested: 0, deduped: 1 })
  })

  test("S7: strict ingest accepts all 13 arms and rejects contradictory envelope fields", async () => {
    const base = {
      sessionId: "sess-arms",
      source: "claude_code" as const,
      sourceSchemaVersion: 1,
      trackId: "main",
    }
    const messages: IngestPayload["records"][number]["messages"] = [
      {
        ...base,
        subIndex: 0,
        msgType: "message",
        role: "assistant",
        content: { type: "text", value: "hi" },
      },
      {
        ...base,
        subIndex: 1,
        msgType: "toolCall",
        details: { callId: "c1", name: "Read", input: {} },
      },
      {
        ...base,
        subIndex: 2,
        msgType: "toolResult",
        details: { callId: "c1", output: {}, status: "success" },
      },
      { ...base, subIndex: 3, msgType: "progress", details: { progressType: "bash" } },
      {
        ...base,
        subIndex: 4,
        msgType: "hookCall",
        details: { phase: "progress", type: "hook_progress" },
      },
      { ...base, subIndex: 5, msgType: "queueOperation", details: { operation: "enqueue" } },
      {
        ...base,
        subIndex: 6,
        msgType: "turnEvent",
        details: { type: "duration", status: "completed" },
      },
      { ...base, subIndex: 7, msgType: "compaction", details: { type: "boundary" } },
      { ...base, subIndex: 8, msgType: "localCommand", details: { command: "/help" } },
      { ...base, subIndex: 9, msgType: "fileEvent", details: { type: "edited", path: "a.ts" } },
      {
        ...base,
        subIndex: 10,
        msgType: "usage",
        details: { type: "tokens", tokens: { input: 1, output: 2, cached: 0, thinking: 0 } },
      },
      { ...base, subIndex: 11, msgType: "systemEvent", subType: "runtime_error" },
      { ...base, subIndex: 12, msgType: "custom", subType: "future" },
    ]
    const payload: IngestPayload = {
      type: "main",
      sessionId: "sess-arms",
      sourceRelativePath: "sess-arms.jsonl",
      project,
      records: [
        {
          lineUuid: "0191d942-3ba5-7dba-9a7d-22d65b302590",
          lineNumber: 1,
          raw: { safe: true },
          messages,
        },
      ],
    }

    expect((await post(app, payload, cliToken)).status).toBe(200)
    const contradictory = {
      ...payload,
      records: [
        {
          ...payload.records[0],
          messages: [{ ...payload.records[0]?.messages[0], trackId: "agent:wrong" }],
        },
      ],
    }
    expect((await post(app, contradictory, cliToken)).status).toBe(400)
  })

  test("S9: a basic transcript reaches authenticated storage and checkpoints without loss", async () => {
    const root = await mkdtemp(join(tmpdir(), "samskara-e2e-"))
    const dir = join(root, ".claude", "projects", "bucket")
    await mkdir(dir, { recursive: true })
    const transcript = join(dir, "sess-e2e.jsonl")
    const unknown = { type: "future_record", cwd: "/work/app", token: "secret-value" }
    const assistant = {
      type: "assistant",
      sessionId: "sess-e2e",
      cwd: "/work/app",
      uuid: "0191d942-3ba5-7dba-9a7d-22d65b302599",
      message: {
        role: "assistant",
        usage: { input_tokens: 2, output_tokens: 1 },
        content: [
          { type: "text", text: "hello" },
          { type: "tool_use", id: "call-e2e", name: "Read", input: { path: "a.ts" } },
        ],
      },
    }
    await writeFile(
      transcript,
      `\n${JSON.stringify(unknown)}\n${JSON.stringify(assistant)}\n`,
      "utf8",
    )

    const plugin = createClaudePlugin(nodeFs)
    const log = createLogger({ service: "e2e" }, { level: "silent" })
    const empty: CheckpointStore = { checkpoints: {} }
    const batches = await plugin.collect(empty, {
      fs: nodeFs,
      glob: async () => [transcript],
      resolveProject: async () => project,
      log,
    })
    const track = batches[0]?.tracks[0]
    if (!track) throw new Error("expected ingest track")
    const { checkpointKey: _key, checkpointAt, lastLineProcessed: _last, ...payload } = track

    const response = await post(app, payload, cliToken)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ingested: 3, deduped: 0 })

    const rows = await db
      .select()
      .from(messages)
      .where(eq(messages.sessionId, "sess-e2e"))
      .orderBy(messages.lineNumber, messages.subIndex)
    expect(rows.map((row) => row.msgType)).toEqual(["custom", "message", "toolCall"])
    expect(JSON.stringify(rows)).not.toContain("secret-value")
    expect(rows[0]?.raw).toMatchObject({ token: "[Redacted]" })
    expect(await db.select().from(toolCall).where(eq(toolCall.toolId, "call-e2e"))).toHaveLength(1)
    expect(await db.select().from(tokenUsage)).toContainEqual(
      expect.objectContaining({ inputTokens: 2, outputTokens: 1 }),
    )

    const body = checkpointAt(4)
    const checkpointed: CheckpointStore = {
      checkpoints: {
        [transcript]: {
          ...body,
          filePath: transcript,
          lastUpdatedAt: "2026-07-25T00:00:00.000Z",
        },
      },
    }
    expect(
      await plugin.collect(checkpointed, {
        fs: nodeFs,
        glob: async () => [transcript],
        resolveProject: async () => project,
        log,
      }),
    ).toEqual([])
  })

  test("S17: a selected session and persisted fixture have no missing source lines", async () => {
    const projectsRoot = await mkdtemp(join(tmpdir(), "samskara-session-coverage-"))
    const root = join(projectsRoot, ".claude", "projects")
    const bucket = join(root, "encoded-project")
    const main = join(bucket, "sess-semantic.jsonl")
    const agentA = join(bucket, "sess-semantic", "subagents", "agent-a.jsonl")
    const agentB = join(bucket, "sess-semantic", "subagents", "workflows", "wf-1", "agent-b.jsonl")
    const journal = join(bucket, "sess-semantic", "subagents", "workflows", "wf-1", "journal.jsonl")
    await mkdir(join(agentB, ".."), { recursive: true })
    await mkdir(join(agentA, ".."), { recursive: true })
    const mainLines = [
      {
        type: "assistant",
        cwd: "/work/app",
        uuid: "0191d942-3ba5-7dba-9a7d-22d65b302600",
        message: {
          role: "assistant",
          usage: { input_tokens: 3, output_tokens: 2 },
          content: [
            { type: "text", text: "hello" },
            { type: "tool_use", id: "call-semantic", name: "Task", input: { agent: "a" } },
          ],
        },
      },
      { type: "ai-title", cwd: "/work/app", title: "Private title" },
    ]
    const agentALine = {
      type: "attachment",
      cwd: "/work/app",
      attachment: { type: "hook_success", hookId: "hook-a", toolUseID: "call-semantic" },
    }
    const agentBLine = {
      type: "attachment",
      cwd: "/work/app",
      attachment: { type: "queued_command", prompt: "continue", origin: { kind: "human" } },
    }
    await writeFile(main, `${mainLines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8")
    await writeFile(agentA, `${JSON.stringify(agentALine)}\n`, "utf8")
    await writeFile(agentB, `${JSON.stringify(agentBLine)}\n`, "utf8")
    await writeFile(journal, `${JSON.stringify({ type: "started" })}\n`, "utf8")
    await writeFile(
      agentA.replace(/\.jsonl$/, ".meta.json"),
      JSON.stringify({ agentId: "a", spawnToolUseId: "call-semantic", spawnDepth: 1 }),
      "utf8",
    )
    await writeFile(
      agentB.replace(/\.jsonl$/, ".meta.json"),
      JSON.stringify({ agentId: "b", spawnDepth: 1 }),
      "utf8",
    )

    const coverageOutput = execFileSync(
      "bun",
      ["run", "test:claude-session", "sess-semantic", root],
      { cwd: join(packageDir, "../.."), encoding: "utf8" },
    )
    const coverage: unknown = JSON.parse(coverageOutput)
    expect(coverage).toMatchObject({
      sessionId: "sess-semantic",
      mainTranscriptCount: 1,
      agentTranscriptCount: 2,
      totals: { sourceLineCount: 4, parsedRecordCount: 4, normalizedMessageCount: 5 },
    })
    if (
      typeof coverage !== "object" ||
      coverage === null ||
      !("tracks" in coverage) ||
      !Array.isArray(coverage.tracks) ||
      !coverage.tracks.every(isCoverageTrack)
    ) {
      throw new Error("expected coverage tracks")
    }
    expect(coverage.tracks.map((track) => track.sourceRelativePath)).toEqual([
      "sess-semantic.jsonl",
      "sess-semantic/subagents/agent-a.jsonl",
      "sess-semantic/subagents/workflows/wf-1/agent-b.jsonl",
    ])
    expect(
      coverage.tracks.every((track) => track.sourceLineCount === track.parsedRecordCount),
    ).toBe(true)

    const plugin = createClaudePlugin(nodeFs)
    const batches = await plugin.collect(
      { checkpoints: {} },
      {
        fs: nodeFs,
        glob: async () => [journal, agentB, agentA, main],
        resolveProject: async () => project,
        log: createLogger({ service: "semantic-e2e" }, { level: "silent" }),
      },
    )
    const tracks = batches[0]?.tracks ?? []
    const expectedKeys = tracks.flatMap((track) =>
      track.records.flatMap((record) =>
        record.messages.map(
          (message) => `${track.sessionId}:${record.lineUuid}:${message.subIndex}`,
        ),
      ),
    )
    for (const track of tracks) {
      const {
        checkpointKey: _checkpointKey,
        checkpointAt: _checkpointAt,
        lastLineProcessed: _lastLineProcessed,
        ...payload
      } = track
      const response = await post(app, payload, cliToken)
      expect(response.status).toBe(200)
    }

    const stored = await db
      .select()
      .from(messages)
      .where(eq(messages.sessionId, "sess-semantic"))
      .orderBy(messages.lineNumber, messages.subIndex)
    const storedKeys = stored.map(
      (message) => `${message.sessionId}:${message.lineUuid}:${message.subIndex}`,
    )
    expect([...storedKeys].sort()).toEqual([...expectedKeys].sort())
    expect(stored.map((message) => message.msgType).sort()).toEqual([
      "custom",
      "hookCall",
      "message",
      "message",
      "toolCall",
    ])
    expect(stored.find((message) => message.subType === "ai-title")?.details).toBeNull()
    expect(
      await db
        .select({ title: sessions.title })
        .from(sessions)
        .where(eq(sessions.id, "sess-semantic")),
    ).toEqual([{ title: null }])
    expect(
      await db.select().from(toolCall).where(eq(toolCall.toolId, "call-semantic")),
    ).toHaveLength(1)
    expect(await db.select().from(tokenUsage)).toContainEqual(
      expect.objectContaining({ inputTokens: 3, outputTokens: 2 }),
    )
    expect(
      await db.select().from(subagents).where(eq(subagents.sessionId, "sess-semantic")),
    ).toHaveLength(2)
  })

  test("a recorded Claude session persists every message family it contains, with its tool pair joined", async () => {
    const root = await mkdtemp(join(tmpdir(), "samskara-real-"))
    const dir = join(root, ".claude", "projects", "bucket")
    await mkdir(dir, { recursive: true })
    const transcript = join(dir, "sess-real.jsonl")
    await writeFile(transcript, await readFile(fixturePath, "utf8"), "utf8")

    const batches = await createClaudePlugin(nodeFs).collect(
      { checkpoints: {} },
      {
        fs: nodeFs,
        glob: async () => [transcript],
        resolveProject: async () => project,
        log: createLogger({ service: "real" }, { level: "silent" }),
      },
    )
    const track = batches[0]?.tracks[0]
    if (!track) throw new Error("expected an ingest track")
    const { checkpointKey: _k, checkpointAt: _a, lastLineProcessed: _l, ...payload } = track
    const sessionId = payload.sessionId

    const response = await post(app, payload, cliToken)
    expect(response.status).toBe(200)
    const { ingested } = (await response.json()) as { ingested: number }

    const stored = await db.select().from(messages).where(eq(messages.sessionId, sessionId))
    expect(stored).toHaveLength(ingested)

    const familiesInPayload = new Set(
      payload.records.flatMap((r) => r.messages.map((m) => m.msgType)),
    )
    expect(new Set(stored.map((row) => row.msgType))).toEqual(familiesInPayload)
    expect([...familiesInPayload].sort()).toEqual([
      "compaction",
      "custom",
      "fileEvent",
      "hookCall",
      "localCommand",
      "message",
      "queueOperation",
      "systemEvent",
      "toolCall",
      "toolResult",
      "turnEvent",
      "usage",
    ])

    const subTypesFor = (family: string) =>
      [...new Set(stored.filter((r) => r.msgType === family).map((r) => r.subType))].sort()
    expect(subTypesFor("systemEvent")).toEqual([
      "away_summary",
      "bridge_status",
      "informational",
      "model_refusal_fallback",
      "scheduled_task_fire",
    ])
    // `file-history-delta` is absent here on purpose: it now parses into a fileEvent rather than
    // falling through to `custom`. Its presence in this list was the recorded symptom of the
    // delta schema requiring `path` when Claude Code emits `trackingPath`.
    expect(subTypesFor("custom")).toEqual([
      "ai-title",
      "bridge-session",
      "last-prompt",
      "mode",
      "permission-mode",
    ])
    // The delta from the same recorded session lands as a fileEvent carrying its backup pointer.
    const deltas = stored.filter(
      (row) => row.msgType === "fileEvent" && (row.details as { type?: string })?.type === "delta",
    )
    expect(deltas.length).toBeGreaterThan(0)

    const ownedMessageIds = new Set(stored.map((row) => row.id))
    const calls = (await db.select().from(toolCall)).filter((row) =>
      ownedMessageIds.has(row.messageId),
    )
    const results = (await db.select().from(toolResult)).filter((row) =>
      ownedMessageIds.has(row.messageId),
    )
    expect(calls.length).toBeGreaterThan(0)
    expect(results.map((r) => r.toolId).sort()).toEqual(calls.map((c) => c.toolId).sort())

    const usage = (await db.select().from(tokenUsage)).filter((row) =>
      ownedMessageIds.has(row.messageId),
    )
    expect(usage.length).toBeGreaterThan(0)
    expect(usage.every((u) => u.inputTokens >= 0 && u.outputTokens >= 0)).toBe(true)

    expect(stored.every((row) => row.lineNumber > 0)).toBe(true)
    expect(JSON.stringify(stored)).not.toContain("/Users/")
  })

  test("re-ingesting the same recorded session stores nothing new", async () => {
    const root = await mkdtemp(join(tmpdir(), "samskara-real-again-"))
    const dir = join(root, ".claude", "projects", "bucket")
    await mkdir(dir, { recursive: true })
    const transcript = join(dir, "sess-real-again.jsonl")
    await writeFile(transcript, await readFile(fixturePath, "utf8"), "utf8")

    const collect = async () => {
      const batches = await createClaudePlugin(nodeFs).collect(
        { checkpoints: {} },
        {
          fs: nodeFs,
          glob: async () => [transcript],
          resolveProject: async () => project,
          log: createLogger({ service: "real" }, { level: "silent" }),
        },
      )
      const track = batches[0]?.tracks[0]
      if (!track) throw new Error("expected an ingest track")
      const { checkpointKey: _k, checkpointAt: _a, lastLineProcessed: _l, ...payload } = track
      return payload
    }

    const payload = await collect()
    const first = (await (await post(app, payload, cliToken)).json()) as { ingested: number }
    const second = (await (await post(app, payload, cliToken)).json()) as {
      ingested: number
      deduped: number
    }

    expect(first.ingested).toBeGreaterThan(0)
    expect(second).toEqual({ ingested: 0, deduped: first.ingested })
  })

  test("SC22: ingest with a writable projectId stores the session there", async () => {
    const [member] = await db
      .insert(users)
      .values({ githubId: 9101, githubLogin: "sc22-member" })
      .returning()
    if (!member) throw new Error("seed member failed")
    const [org] = await db
      .insert(orgs)
      .values({ githubSlug: "sc22-acme", name: "Acme" })
      .returning({ id: orgs.id })
    if (!org) throw new Error("seed org failed")
    await db.insert(userOrgs).values({ userId: member.id, orgId: org.id })
    const { id: projectId } = await projectsRepo.upsertOwned(db, {
      identity: { name: "widget", slug: "sc22-widget" },
      owner: { kind: "org", orgId: org.id },
    })
    const memberToken = await signToken(env, { sub: member.id, aud: "cli" })
    const projectCountBefore = (await db.select({ id: projects.id }).from(projects)).length

    const res = await post(
      app,
      mainPayload("sess-sc22", { name: "ignored", slug: "sc22-ignored-slug", projectId }),
      memberToken,
    )
    expect(res.status).toBe(200)

    const [session] = await db.select().from(sessions).where(eq(sessions.id, "sess-sc22"))
    expect(session?.projectId).toBe(projectId)
    expect((await db.select({ id: projects.id }).from(projects)).length).toBe(projectCountBefore)
  })

  test("SC23: ingest with a projectId the caller cannot write is refused", async () => {
    const [otherOwner] = await db
      .insert(users)
      .values({ githubId: 9102, githubLogin: "sc23-owner" })
      .returning()
    if (!otherOwner) throw new Error("seed owner failed")
    const projectId = await projectsRepo.upsert(db, {
      identity: { name: "private", slug: "sc23-private" },
      ownerId: otherOwner.id,
    })

    const res = await post(
      app,
      mainPayload("sess-sc23", { name: "ignored", slug: "sc23-ignored-slug", projectId }),
      cliToken,
    )
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: "projectForbidden" })
    expect(await db.select().from(sessions).where(eq(sessions.id, "sess-sc23"))).toHaveLength(0)
    expect(
      await db.select().from(messages).where(eq(messages.sessionId, "sess-sc23")),
    ).toHaveLength(0)
  })

  test("SC24: ingest without projectId applies the owner rule", async () => {
    const [member] = await db
      .insert(users)
      .values({ githubId: 9103, githubLogin: "sc24-member" })
      .returning()
    if (!member) throw new Error("seed member failed")
    const [org] = await db
      .insert(orgs)
      .values({ githubSlug: "sc24-acme", name: "Acme" })
      .returning({ id: orgs.id })
    if (!org) throw new Error("seed org failed")
    await db.insert(userOrgs).values({ userId: member.id, orgId: org.id })
    const memberToken = await signToken(env, { sub: member.id, aud: "cli" })

    const res = await post(
      app,
      mainPayload("sess-sc24", {
        name: "widget",
        slug: "sc24-widget",
        remote: { host: "github.com", owner: "sc24-acme", repoName: "widget" },
      }),
      memberToken,
    )
    expect(res.status).toBe(200)

    const [session] = await db.select().from(sessions).where(eq(sessions.id, "sess-sc24"))
    const [sessionProject] = await db
      .select()
      .from(projects)
      .where(eq(projects.id, session?.projectId ?? ""))
    expect(sessionProject?.ownerOrgId).toBe(org.id)
  })

  test("SC26 (regression): a payload with only name and slug still lands in the caller's personal project", async () => {
    const res = await post(
      app,
      mainPayload("sess-sc26", { name: "solo", slug: "sc26-solo" }),
      cliToken,
    )
    expect(res.status).toBe(200)

    const [session] = await db.select().from(sessions).where(eq(sessions.id, "sess-sc26"))
    const [sessionProject] = await db
      .select()
      .from(projects)
      .where(eq(projects.id, session?.projectId ?? ""))
    expect(sessionProject?.ownerUserId).toBe(routeUserId)
  })

  test("a rejected payload logs the fields that failed, so a 400 is diagnosable from the log alone", async () => {
    const capture = captureLogger()
    const loud = buildApp(db, env, { rootLog: capture.log })

    const res = await post(loud, { type: "main", sessionId: "x" }, cliToken)

    expect(res.status).toBe(400)
    const [line] = capture.at("warn")
    expect(line?.msg).toBe("request validation failed")
    expect((line?.issues as ReadonlyArray<{ path: string }> | undefined)?.length).toBeGreaterThan(0)
    expect(line?.reqId).toBeTruthy()
  })

  test("a 409 warns with the session it could not find, rather than leaving a bare status", async () => {
    const capture = captureLogger()
    const loud = buildApp(db, env, { rootLog: capture.log })

    const res = await post(loud, subagentPayload("no-session-logged"), cliToken)

    expect(res.status).toBe(409)
    const [line] = capture.at("warn")
    expect(line?.msg).toBe("ingest rejected: no such session for this user")
    expect(line?.sessionId).toBe("no-session-logged")
    expect(line?.userId).toBe(routeUserId)
  })

  test("a 403 warns with the project the caller was refused, and by whom", async () => {
    const [otherOwner] = await db
      .insert(users)
      .values({ githubId: 9104, githubLogin: "forbidden-log-owner" })
      .returning()
    if (!otherOwner) throw new Error("seed owner failed")
    const projectId = await projectsRepo.upsert(db, {
      identity: { name: "private", slug: "forbidden-log-private" },
      ownerId: otherOwner.id,
    })

    const capture = captureLogger()
    const loud = buildApp(db, env, { rootLog: capture.log })
    const res = await post(
      loud,
      mainPayload("sess-forbidden-log", { name: "x", slug: "x-slug", projectId }),
      cliToken,
    )

    expect(res.status).toBe(403)
    const [line] = capture.at("warn")
    expect(line?.msg).toBe("ingest rejected: project not writable by this user")
    expect(line?.projectId).toBe(projectId)
    expect(line?.userId).toBe(routeUserId)
  })

  test("an accepted ingest reports who sent what, on one line", async () => {
    const capture = captureLogger()
    const loud = buildApp(db, env, { rootLog: capture.log })

    await post(loud, mainPayload("sess-observability"), cliToken)

    const [line] = capture.at("info").filter((entry) => entry.msg === "request complete")
    expect(line?.userId).toBe(routeUserId)
    expect(line?.sessionId).toBe("sess-observability")
    expect(line?.repo).toBe(project.slug)
    expect(line?.eventCount).toBe(1)
    expect(line?.status).toBe(200)
    expect(line?.reqId).toBeTruthy()
  })
})
