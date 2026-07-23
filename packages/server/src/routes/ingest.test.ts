import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import type { IngestPayload } from "@samskara/core"
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { buildApp } from "../app.js"
import { type Db, createDb } from "../db/client.js"
import { messages, users } from "../db/schema.js"
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
  cookieSecure: false,
  jwtSecret: "test-secret-value",
  jwtExpiresIn: "7d",
}

const project = { name: "widget", slug: "acme-widget" } as const

const mainPayload = (sessionId: string): IngestPayload => ({
  type: "main",
  sessionId,
  sourceRelativePath: `${sessionId}.jsonl`,
  project,
  session: { model: "claude-opus-4-8" },
  rawLines: [{ lineUuid: "l1", raw: "{}" }],
  messages: [
    {
      lineUuid: "l1",
      subIndex: 0,
      sessionId,
      source: "claude_code",
      sourceSchemaVersion: 1,
      msgType: "assistant",
      timestamp: "2026-07-23T00:00:00.000Z",
      lineNumber: 1,
      content: "hi",
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
      rawLines: [{ lineUuid: "z1", raw: "{}" }],
      messages: [
        {
          lineUuid: "z1",
          subIndex: 0,
          sessionId: "no-session",
          source: "claude_code",
          sourceSchemaVersion: 1,
          msgType: "assistant",
          timestamp: "2026-07-23T00:00:00.000Z",
          lineNumber: 1,
          agentId: "agent-z",
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
})
