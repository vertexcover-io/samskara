import { describe, expect, test } from "vitest"
import { loadEnv } from "./env.js"

const complete = {
  GITHUB_CLIENT_ID: "cid",
  GITHUB_CLIENT_SECRET: "secret",
  PUBLIC_BASE_URL: "http://localhost:3000",
  WEB_BASE_URL: "http://localhost:8000",
  COOKIE_SECURE: "false",
  JWT_SECRET: "jwt",
}

describe("loadEnv", () => {
  test("reads a complete source into a typed Env with COOKIE_SECURE coerced to false", () => {
    const env = loadEnv(complete)
    expect(env).toEqual({
      githubClientId: "cid",
      githubClientSecret: "secret",
      publicBaseUrl: "http://localhost:3000",
      webBaseUrl: "http://localhost:8000",
      cookieSecure: false,
      jwtSecret: "jwt",
      jwtExpiresIn: "7d",
      db: {
        poolMax: 10,
        connectTimeoutSeconds: 10,
        idleTimeoutSeconds: 30,
        statementTimeoutSeconds: 30,
      },
      serverTiming: false,
    })
  })

  test("defaults JWT_EXPIRES_IN to 7d and honors an override", () => {
    expect(loadEnv(complete).jwtExpiresIn).toBe("7d")
    expect(loadEnv({ ...complete, JWT_EXPIRES_IN: "1h" }).jwtExpiresIn).toBe("1h")
  })

  test("coerces COOKIE_SECURE=true to boolean true", () => {
    expect(loadEnv({ ...complete, COOKIE_SECURE: "true" }).cookieSecure).toBe(true)
  })

  test("reads explicit database pool and timeout configuration", () => {
    expect(
      loadEnv({
        ...complete,
        DB_POOL_MAX: "12",
        DB_CONNECT_TIMEOUT_SECONDS: "8",
        DB_IDLE_TIMEOUT_SECONDS: "45",
        DB_STATEMENT_TIMEOUT_SECONDS: "60",
      }).db,
    ).toEqual({
      poolMax: 12,
      connectTimeoutSeconds: 8,
      idleTimeoutSeconds: 45,
      statementTimeoutSeconds: 60,
    })
  })

  test("enables Server-Timing only with explicit server configuration", () => {
    expect(loadEnv({ ...complete, SERVER_TIMING: "true" }).serverTiming).toBe(true)
  })

  test("rejects invalid database configuration ranges", () => {
    expect(() => loadEnv({ ...complete, DB_POOL_MAX: "0" })).toThrow(/DB_POOL_MAX/)
    expect(() => loadEnv({ ...complete, DB_CONNECT_TIMEOUT_SECONDS: "fast" })).toThrow(
      /DB_CONNECT_TIMEOUT_SECONDS/,
    )
  })

  test("throws naming the missing key when JWT_SECRET is absent", () => {
    const { JWT_SECRET, ...rest } = complete
    expect(() => loadEnv(rest)).toThrow(/JWT_SECRET/)
  })

  test("throws when a required key is present but empty", () => {
    expect(() => loadEnv({ ...complete, GITHUB_CLIENT_ID: "" })).toThrow(/GITHUB_CLIENT_ID/)
  })
})
