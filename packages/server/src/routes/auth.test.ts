import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import { eq } from "drizzle-orm"
import { SignJWT } from "jose"
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest"
import { buildApp } from "../app.js"
import { type Db, createDb } from "../db/client.js"
import { orgs, userOrgs, users } from "../db/schema.js"
import type { Env } from "../lib/env.js"
import { signToken, verifyToken } from "../lib/jwt.js"
import { seedOrg } from "../scripts/seed-org.js"
import type { User } from "../services/auth.js"
import type { GithubClient, GithubProfile } from "../services/github.js"
import { createPairingStore } from "../services/pairing.js"

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
  githubClientId: "Ov23linvZE00y7VZSI4Y",
  githubClientSecret: "secret",
  publicBaseUrl: "http://localhost:3000",
  webBaseUrl: "http://localhost:8000",
  cookieSecure: false,
  jwtSecret: "test-secret-value",
  jwtExpiresIn: "7d",
}

const stubClient = (opts: {
  orgs: ReadonlyArray<string>
  profile: GithubProfile
}): GithubClient => ({
  exchangeCode: async () => ({ accessToken: "gh-token" }),
  getProfile: async () => opts.profile,
  getOrgs: async () => opts.orgs,
  getVerifiedEmails: async () => [],
})

const sessionFrom = (setCookie: string | null): string | undefined =>
  setCookie
    ?.split(/,(?=\s*\w+=)/)
    .find((c) => c.trimStart().startsWith("session="))
    ?.trimStart()
    .slice("session=".length)
    .split(";")[0]

describe.skipIf(!dockerAvailable())("auth routes (callback + start)", () => {
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

  beforeEach(async () => {
    await db.delete(userOrgs)
    await db.delete(users)
    await db.delete(orgs)
    await seedOrg(db, "vertexcover-io")
  })

  test("S1: happy-path callback creates user + membership + aud:web session", async () => {
    const app = buildApp(db, env, {
      githubClient: stubClient({
        orgs: ["vertexcover-io"],
        profile: { githubId: 4242, login: "octocat" },
      }),
    })

    const res = await app.request("/api/auth/github/callback?code=x&state=s", {
      headers: { cookie: "oauth_state=s" },
    })

    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toBe("http://localhost:8000/")

    const setCookie = res.headers.get("set-cookie")
    const token = sessionFrom(setCookie)
    expect(token).toBeTruthy()

    const [user] = await db.select().from(users).where(eq(users.githubId, 4242))
    expect(user).toBeDefined()
    if (!user) throw new Error("no user")
    expect(await verifyToken(env, token as string, "web")).toEqual({ sub: user.id })

    const memberships = await db.select().from(userOrgs).where(eq(userOrgs.userId, user.id))
    expect(memberships).toHaveLength(1)
  })

  test("S2: non-member is rejected and no user row is persisted", async () => {
    const app = buildApp(db, env, {
      githubClient: stubClient({
        orgs: ["some-other-org"],
        profile: { githubId: 5555, login: "stranger" },
      }),
    })

    const res = await app.request("/api/auth/github/callback?code=x&state=s", {
      headers: { cookie: "oauth_state=s" },
    })

    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toBe("http://localhost:8000/?error=not_member")
    expect(sessionFrom(res.headers.get("set-cookie"))).toBeUndefined()

    const allUsers = await db.select().from(users)
    expect(allUsers).toHaveLength(0)
  })

  test("S3: state mismatch is rejected as bad_state with no session and no exchange", async () => {
    let exchanged = false
    const app = buildApp(db, env, {
      githubClient: {
        exchangeCode: async () => {
          exchanged = true
          return { accessToken: "gh-token" }
        },
        getProfile: async () => ({ githubId: 1, login: "x" }),
        getOrgs: async () => ["vertexcover-io"],
        getVerifiedEmails: async () => [],
      },
    })

    const res = await app.request("/api/auth/github/callback?code=x&state=s1", {
      headers: { cookie: "oauth_state=s2" },
    })

    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toBe("http://localhost:8000/?error=bad_state")
    expect(sessionFrom(res.headers.get("set-cookie"))).toBeUndefined()
    expect(exchanged).toBe(false)
  })

  test("S4: repeated callback for the same github_id does not duplicate user or membership", async () => {
    const build = (login: string) =>
      buildApp(db, env, {
        githubClient: stubClient({
          orgs: ["vertexcover-io"],
          profile: { githubId: 7777, login },
        }),
      })

    await build("first-login").request("/api/auth/github/callback?code=x&state=s", {
      headers: { cookie: "oauth_state=s" },
    })
    await build("renamed-login").request("/api/auth/github/callback?code=x&state=s", {
      headers: { cookie: "oauth_state=s" },
    })

    const rows = await db.select().from(users).where(eq(users.githubId, 7777))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.githubLogin).toBe("renamed-login")

    if (!rows[0]) throw new Error("no user")
    const memberships = await db.select().from(userOrgs).where(eq(userOrgs.userId, rows[0].id))
    expect(memberships).toHaveLength(1)
  })

  test("S7: /start redirects to GitHub authorize with matching state cookie and scopes", async () => {
    const app = buildApp(db, env, {
      githubClient: stubClient({ orgs: [], profile: { githubId: 1, login: "x" } }),
    })

    const res = await app.request("/api/auth/github/start")

    expect(res.status).toBe(302)
    const location = res.headers.get("location")
    if (!location) throw new Error("no location")
    const url = new URL(location)
    expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize")
    expect(url.searchParams.get("client_id")).toBe("Ov23linvZE00y7VZSI4Y")
    expect(url.searchParams.get("redirect_uri")).toBe(
      "http://localhost:3000/api/auth/github/callback",
    )
    expect(url.searchParams.get("scope")).toBe("read:org user:email")

    const state = url.searchParams.get("state")
    expect(state).toBeTruthy()
    const setCookie = res.headers.get("set-cookie")
    expect(setCookie).toContain(`oauth_state=${state}`)
  })
})

const noopClient: GithubClient = stubClient({
  orgs: [],
  profile: { githubId: 0, login: "noop" },
})

const seedUser = (db: Db): Promise<User> =>
  db
    .insert(users)
    .values({
      githubId: 909090,
      githubLogin: "authed-user",
      email: "authed@example.com",
      name: "Authed User",
      avatarUrl: "https://example.com/a.png",
    })
    .returning()
    .then(([user]) => {
      if (!user) throw new Error("no seeded user")
      return user
    })

const clearedSession = (setCookie: string | null): boolean =>
  (setCookie ?? "")
    .split(/,(?=\s*\w+=)/)
    .some((c) => c.trimStart().startsWith("session=;") || /session=;/.test(c))

describe.skipIf(!dockerAvailable())("auth routes (me + logout)", () => {
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

  beforeEach(async () => {
    await db.delete(userOrgs)
    await db.delete(users)
    await db.delete(orgs)
  })

  test("S8: /me with a valid web session cookie returns the public user, no internal fields", async () => {
    const user = await seedUser(db)
    const token = await signToken(env, { sub: user.id, aud: "web" })
    const app = buildApp(db, env, { githubClient: noopClient })

    const res = await app.request("/api/auth/me", {
      headers: { cookie: `session=${token}` },
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({
      id: user.id,
      githubLogin: "authed-user",
      email: "authed@example.com",
      name: "Authed User",
      avatarUrl: "https://example.com/a.png",
    })
    expect(body).not.toHaveProperty("githubId")
    expect(body).not.toHaveProperty("createdAt")
    expect(body).not.toHaveProperty("updatedAt")
  })

  test("S9: /me with no cookie and no bearer is 401", async () => {
    const app = buildApp(db, env, { githubClient: noopClient })

    const res = await app.request("/api/auth/me")

    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body).not.toHaveProperty("id")
  })

  test("S10: /me with a tampered session token is 401", async () => {
    const user = await seedUser(db)
    const tampered = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer("samskara")
      .setAudience("web")
      .setSubject(user.id)
      .setExpirationTime("7d")
      .sign(new TextEncoder().encode("other-secret"))
    const app = buildApp(db, env, { githubClient: noopClient })

    const res = await app.request("/api/auth/me", {
      headers: { cookie: `session=${tampered}` },
    })

    expect(res.status).toBe(401)
  })

  test("S11: /logout returns { ok: true }, clears the session cookie, and a re-read with the cleared cookie is 401", async () => {
    const user = await seedUser(db)
    const token = await signToken(env, { sub: user.id, aud: "web" })
    const app = buildApp(db, env, { githubClient: noopClient })

    const res = await app.request("/api/auth/logout", {
      method: "POST",
      headers: { cookie: `session=${token}` },
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(clearedSession(res.headers.get("set-cookie"))).toBe(true)

    const after = await app.request("/api/auth/me", {
      headers: { cookie: "session=" },
    })
    expect(after.status).toBe(401)
  })

  test("S12: /me accepts a valid web token via Authorization: Bearer with no cookie", async () => {
    const user = await seedUser(db)
    const token = await signToken(env, { sub: user.id, aud: "web" })
    const app = buildApp(db, env, { githubClient: noopClient })

    const res = await app.request("/api/auth/me", {
      headers: { authorization: `Bearer ${token}` },
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ id: user.id, githubLogin: "authed-user" })
  })

  test("S13: session round-trip - callback sets a session, /me returns the user, logout then /me is 401", async () => {
    await seedOrg(db, "vertexcover-io")
    const app = buildApp(db, env, {
      githubClient: stubClient({
        orgs: ["vertexcover-io"],
        profile: { githubId: 314159, login: "roundtrip" },
      }),
    })

    const callback = await app.request("/api/auth/github/callback?code=x&state=s", {
      headers: { cookie: "oauth_state=s" },
    })
    expect(callback.status).toBe(302)
    const token = sessionFrom(callback.headers.get("set-cookie"))
    expect(token).toBeTruthy()

    const me = await app.request("/api/auth/me", {
      headers: { cookie: `session=${token}` },
    })
    expect(me.status).toBe(200)
    const meBody = await me.json()
    expect(meBody).toMatchObject({ githubLogin: "roundtrip" })

    const logout = await app.request("/api/auth/logout", {
      method: "POST",
      headers: { cookie: `session=${token}` },
    })
    expect(logout.status).toBe(200)
    expect(clearedSession(logout.headers.get("set-cookie"))).toBe(true)

    const afterLogout = await app.request("/api/auth/me", {
      headers: { cookie: "session=" },
    })
    expect(afterLogout.status).toBe(401)
  })
})

const jsonPost = (body: unknown, cookie?: string): RequestInit => ({
  method: "POST",
  headers: {
    "content-type": "application/json",
    ...(cookie ? { cookie } : {}),
  },
  body: JSON.stringify(body),
})

describe.skipIf(!dockerAvailable())("auth routes (cli pairing)", () => {
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

  beforeEach(async () => {
    await db.delete(userOrgs)
    await db.delete(users)
    await db.delete(orgs)
  })

  test("S14: mint then exchange yields an aud:cli token whose sub is the minting user", async () => {
    const user = await seedUser(db)
    const webToken = await signToken(env, { sub: user.id, aud: "web" })
    const app = buildApp(db, env, { githubClient: noopClient })

    const minted = await app.request("/api/auth/cli-code", jsonPost({}, `session=${webToken}`))
    expect(minted.status).toBe(200)
    const { code } = (await minted.json()) as { code: string }
    expect(code).toBeTruthy()

    const exchanged = await app.request("/api/auth/cli-exchange", jsonPost({ code }))
    expect(exchanged.status).toBe(200)
    const { token } = (await exchanged.json()) as { token: string }

    expect(await verifyToken(env, token, "cli")).toEqual({ sub: user.id })
  })

  test("S15: a pairing code is single-use - second exchange is 401", async () => {
    const user = await seedUser(db)
    const webToken = await signToken(env, { sub: user.id, aud: "web" })
    const app = buildApp(db, env, { githubClient: noopClient })

    const minted = await app.request("/api/auth/cli-code", jsonPost({}, `session=${webToken}`))
    const { code } = (await minted.json()) as { code: string }

    const first = await app.request("/api/auth/cli-exchange", jsonPost({ code }))
    expect(first.status).toBe(200)

    const second = await app.request("/api/auth/cli-exchange", jsonPost({ code }))
    expect(second.status).toBe(401)
  })

  test("S16: a code exchanged after its 5m TTL is 401 with no token", async () => {
    let now = 2_000_000
    const pairingStore = createPairingStore(() => now)
    const user = await seedUser(db)
    const webToken = await signToken(env, { sub: user.id, aud: "web" })
    const app = buildApp(db, env, { githubClient: noopClient, pairingStore })

    const minted = await app.request("/api/auth/cli-code", jsonPost({}, `session=${webToken}`))
    const { code } = (await minted.json()) as { code: string }

    now += 5 * 60 * 1000 + 1
    const exchanged = await app.request("/api/auth/cli-exchange", jsonPost({ code }))
    expect(exchanged.status).toBe(401)
    expect(await exchanged.json()).not.toHaveProperty("token")
  })

  test("S17: /cli-code with no web session is 401", async () => {
    const app = buildApp(db, env, { githubClient: noopClient })

    const res = await app.request("/api/auth/cli-code", jsonPost({}))

    expect(res.status).toBe(401)
    expect(await res.json()).not.toHaveProperty("code")
  })

  test("S15b: cli-exchange with a missing/empty code is 400 with no token", async () => {
    const app = buildApp(db, env, { githubClient: noopClient })

    const missing = await app.request("/api/auth/cli-exchange", jsonPost({}))
    expect(missing.status).toBe(400)
    expect(await missing.json()).not.toHaveProperty("token")

    const empty = await app.request("/api/auth/cli-exchange", jsonPost({ code: "" }))
    expect(empty.status).toBe(400)
  })

  test("S18: an aud:cli token on /me is 401, and a web token fails cli audience verification", async () => {
    const user = await seedUser(db)
    const cliToken = await signToken(env, { sub: user.id, aud: "cli" })
    const app = buildApp(db, env, { githubClient: noopClient })

    const me = await app.request("/api/auth/me", {
      headers: { authorization: `Bearer ${cliToken}` },
    })
    expect(me.status).toBe(401)

    const webToken = await signToken(env, { sub: user.id, aud: "web" })
    expect(await verifyToken(env, webToken, "cli")).toBeNull()
    expect(await verifyToken(env, cliToken, "web")).toBeNull()
  })
})
