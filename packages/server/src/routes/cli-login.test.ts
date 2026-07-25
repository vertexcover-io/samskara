import { execFile, execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { serve } from "@hono/node-server"
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { buildApp } from "../app.js"
import { type Db, createDb } from "../db/client.js"
import { orgs, userOrgs, users } from "../db/schema.js"
import type { Env } from "../lib/env.js"
import { signToken, verifyToken } from "../lib/jwt.js"

const dockerAvailable = () => {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

const packageDir = fileURLToPath(new URL("../..", import.meta.url))
const cliEntry = fileURLToPath(new URL("../../../cli/src/index.ts", import.meta.url))
const execFileAsync = promisify(execFile)

const env: Env = {
  githubClientId: "Ov23linvZE00y7VZSI4Y",
  githubClientSecret: "secret",
  publicBaseUrl: "http://localhost:3000",
  webBaseUrl: "http://localhost:8000",
  cookieSecure: false,
  jwtSecret: "test-secret-value",
  jwtExpiresIn: "7d",
}

describe.skipIf(!dockerAvailable())("cli login round-trip", () => {
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

  test("S19: samskara login --code exchanges a minted code and stores an aud:cli token at 0600", async () => {
    await db.delete(userOrgs)
    await db.delete(users)
    await db.delete(orgs)

    const [user] = await db
      .insert(users)
      .values({ githubId: 111222, githubLogin: "cli-user", name: "CLI User" })
      .returning()
    if (!user) throw new Error("no user")

    const app = buildApp(db, env)
    const server = serve({ fetch: app.fetch, port: 0 })
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("no server address")
    const apiBase = `http://127.0.0.1:${address.port}`

    try {
      const webToken = await signToken(env, { sub: user.id, aud: "web" })
      const minted = await fetch(`${apiBase}/api/auth/cli-code`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: `session=${webToken}` },
        body: JSON.stringify({}),
      })
      const { code } = (await minted.json()) as { code: string }

      const home = mkdtempSync(join(tmpdir(), "samskara-cli-"))
      await execFileAsync("bun", [cliEntry, "login", "--code", code], {
        env: { ...process.env, HOME: home, SAMSKARA_API_URL: apiBase },
      })

      const tokenFile = join(home, ".samskara", "token")
      const stored = readFileSync(tokenFile, "utf8")
      expect(await verifyToken(env, stored, "cli")).toEqual({ sub: user.id })
      expect(statSync(tokenFile).mode & 0o777).toBe(0o600)
    } finally {
      server.close()
    }
  }, 30_000)
})
