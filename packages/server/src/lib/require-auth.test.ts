import { Hono } from "hono"
import { describe, expect, test, vi } from "vitest"
import type { Db } from "../db/client.js"
import type { Env } from "./env.js"
import { signToken } from "./jwt.js"
import { loggingMiddleware } from "./logging-middleware.js"
import { type AuthVariables, requireAuth } from "./require-auth.js"
import { captureLogger } from "./test-logger.js"

const { getUserById } = vi.hoisted(() => ({ getUserById: vi.fn() }))
vi.mock("../services/auth.js", () => ({ getUserById }))

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

const buildApp = (log: ReturnType<typeof captureLogger>["log"]) =>
  new Hono<{ Variables: AuthVariables }>()
    .use(loggingMiddleware(log))
    .get("/guarded", requireAuth({ db: {} as Db, env }, ["cli"]), (c) => c.json({ ok: true }, 200))

const USER_ID = "00000000-0000-4000-8000-000000000001"

describe("requireAuth logging", () => {
  test("a request with no token is a debug line, not a warning -- a logged-out browser is normal", async () => {
    const capture = captureLogger()
    const res = await buildApp(capture.log).request("/guarded")

    expect(res.status).toBe(401)
    expect(capture.at("warn")).toHaveLength(0)
    expect(capture.at("debug")[0]?.msg).toBe("auth rejected: no token")
  })

  test("a token that fails verification warns and names the audiences that were accepted", async () => {
    const capture = captureLogger()
    const res = await buildApp(capture.log).request("/guarded", {
      headers: { authorization: "Bearer not-a-jwt" },
    })

    expect(res.status).toBe(401)
    const [line] = capture.at("warn")
    expect(line?.msg).toBe("auth rejected: token not valid for this endpoint")
    expect(line?.accepted).toEqual(["cli"])
  })

  test("a valid token whose user row is gone warns with the subject id -- the worktree fresh-database trap", async () => {
    getUserById.mockResolvedValue(null)
    const capture = captureLogger()
    const token = await signToken(env, { sub: USER_ID, aud: "cli" })

    const res = await buildApp(capture.log).request("/guarded", {
      headers: { authorization: `Bearer ${token}` },
    })

    expect(res.status).toBe(401)
    const [line] = capture.at("warn")
    expect(line?.msg).toBe("auth rejected: no user row for this token")
    expect(line?.sub).toBe(USER_ID)
  })

  test("no rejection line ever contains the token itself", async () => {
    const capture = captureLogger()
    await buildApp(capture.log).request("/guarded", {
      headers: { authorization: "Bearer super-secret-token" },
    })

    expect(JSON.stringify(capture.lines)).not.toContain("super-secret-token")
  })

  test("an accepted request binds the user id and logs no rejection", async () => {
    getUserById.mockResolvedValue({ id: USER_ID, githubLogin: "dev" })
    const capture = captureLogger()
    const token = await signToken(env, { sub: USER_ID, aud: "cli" })

    const res = await buildApp(capture.log).request("/guarded", {
      headers: { authorization: `Bearer ${token}` },
    })

    expect(res.status).toBe(200)
    expect(capture.at("warn")).toHaveLength(0)
    expect(capture.lines.at(-1)?.userId).toBe(USER_ID)
  })
})
