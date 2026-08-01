import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { buildApp } from "./app.js"
import { type Db, createDb } from "./db/client.js"
import { users } from "./db/schema.js"
import type { Env } from "./lib/env.js"
import { signToken } from "./lib/jwt.js"

const dockerAvailable = () => {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

const packageDir = fileURLToPath(new URL("..", import.meta.url))

const env: Env = {
  githubClientId: "Ov23linvZE00y7VZSI4Y",
  githubClientSecret: "secret",
  publicBaseUrl: "http://localhost:3000",
  webBaseUrl: "http://localhost:8000",
  cookieSecure: false,
  jwtSecret: "test-secret-value",
  jwtExpiresIn: "7d",
}

describe.skipIf(!dockerAvailable())("buildApp", () => {
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

  test("without an injected embeddingClient, a `?q=` search on buildApp's default still returns 200", async () => {
    const [user] = await db
      .insert(users)
      .values({ githubId: 4001, githubLogin: "app-default-user" })
      .returning()
    if (!user) throw new Error("seed user failed")
    const token = await signToken(env, { sub: user.id, aud: "web" })

    const res = await buildApp(db, env).request("/api/sessions?q=anything", {
      headers: { cookie: `session=${token}` },
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ sessions: [] })
  })
})
