import { execFileSync } from "node:child_process"
import { mkdtemp, readFile, rename, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import type { CheckpointStore, FileSystem, IngestPayload } from "@samskara/core"
import { createClaudePlugin, createLogger } from "@samskara/core"
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { buildApp } from "../app.js"
import { type Db, createDb } from "../db/client.js"
import { messages, tokenUsage, toolCall, users } from "../db/schema.js"
import type { Env } from "../lib/env.js"
import { signToken } from "../lib/jwt.js"

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
  githubClientId: "id",
  githubClientSecret: "secret",
  publicBaseUrl: "http://localhost:3000",
  webBaseUrl: "http://localhost:8000",
  cookieSecure: false,
  jwtSecret: "test-secret-value",
  jwtExpiresIn: "7d",
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

const mainPayload = (sessionId: string): IngestPayload => ({
  type: "main",
  sessionId,
  sourceRelativePath: `${sessionId}.jsonl`,
  project,
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
    const dir = await mkdtemp(join(tmpdir(), "samskara-e2e-"))
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
      `\nnot-json\n${JSON.stringify(unknown)}\n${JSON.stringify(assistant)}\n`,
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
    if (!track || track.kind !== "ingest") throw new Error("expected ingest track")
    const {
      kind: _kind,
      checkpointKey: _key,
      checkpointAt,
      outcomes: _outcomes,
      ...payload
    } = track

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
})
