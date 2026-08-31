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
      superAdminLogins: [],
      localLoginSecret: "",
      localLoginLogin: "samskara-dev",
      aiReviewHarness: "opencode",
      aiReviewModel: "zai-coding-plan/glm-5.3-flash",
      aiReviewTimeoutMs: 600000,
    })
  })

  test("defaults the local login to off: empty LOCAL_LOGIN_SECRET, LOCAL_LOGIN_LOGIN samskara-dev", () => {
    const env = loadEnv(complete)
    expect(env.localLoginSecret).toBe("")
    expect(env.localLoginLogin).toBe("samskara-dev")
  })

  test("reads LOCAL_LOGIN_SECRET and LOCAL_LOGIN_LOGIN overrides verbatim", () => {
    const env = loadEnv({
      ...complete,
      LOCAL_LOGIN_SECRET: "open sesame",
      LOCAL_LOGIN_LOGIN: "teammate",
    })
    expect(env.localLoginSecret).toBe("open sesame")
    expect(env.localLoginLogin).toBe("teammate")
  })

  test("parses SUPER_ADMIN_LOGINS into a trimmed, lowercased list", () => {
    expect(
      loadEnv({ ...complete, SUPER_ADMIN_LOGINS: " Harit , riteshK ,, " }).superAdminLogins,
    ).toEqual(["harit", "riteshk"])
  })

  test("treats a blank SUPER_ADMIN_LOGINS as an empty list", () => {
    expect(loadEnv({ ...complete, SUPER_ADMIN_LOGINS: "  " }).superAdminLogins).toEqual([])
  })

  // Production sets PUBLIC_BASE_URL but not WEB_BASE_URL: the API and the UI are one origin,
  // since the server serves the built web app. A localhost fallback here silently sent every
  // post-login redirect to a machine the user is not on.
  test("falls back to PUBLIC_BASE_URL when WEB_BASE_URL is absent", () => {
    const { WEB_BASE_URL: _omitted, ...withoutWeb } = complete
    expect(loadEnv(withoutWeb).webBaseUrl).toBe("http://localhost:3000")
  })

  test("prefers an explicit WEB_BASE_URL over PUBLIC_BASE_URL", () => {
    expect(loadEnv({ ...complete, WEB_BASE_URL: "http://localhost:9999" }).webBaseUrl).toBe(
      "http://localhost:9999",
    )
  })

  test("defaults JWT_EXPIRES_IN to 7d and honors an override", () => {
    expect(loadEnv(complete).jwtExpiresIn).toBe("7d")
    expect(loadEnv({ ...complete, JWT_EXPIRES_IN: "1h" }).jwtExpiresIn).toBe("1h")
  })

  test("coerces COOKIE_SECURE=true to boolean true", () => {
    expect(loadEnv({ ...complete, COOKIE_SECURE: "true" }).cookieSecure).toBe(true)
  })

  test("throws naming the missing key when JWT_SECRET is absent", () => {
    const { JWT_SECRET, ...rest } = complete
    expect(() => loadEnv(rest)).toThrow(/JWT_SECRET/)
  })

  test("throws when a required key is present but empty", () => {
    expect(() => loadEnv({ ...complete, GITHUB_CLIENT_ID: "" })).toThrow(/GITHUB_CLIENT_ID/)
  })

  test("defaults AI_REVIEW_MODEL to zai-coding-plan/glm-5.3-flash and AI_REVIEW_TIMEOUT_MS to 600000", () => {
    const env = loadEnv(complete)
    expect(env.aiReviewModel).toBe("zai-coding-plan/glm-5.3-flash")
    expect(env.aiReviewTimeoutMs).toBe(600000)
  })

  test("reads AI_REVIEW_MODEL verbatim and coerces digit AI_REVIEW_TIMEOUT_MS to a number", () => {
    const env = loadEnv({
      ...complete,
      AI_REVIEW_MODEL: "minimax-coding-plan/MiniMax-M3",
      AI_REVIEW_TIMEOUT_MS: "1500",
    })
    expect(env.aiReviewModel).toBe("minimax-coding-plan/MiniMax-M3")
    expect(env.aiReviewTimeoutMs).toBe(1500)
  })

  test("rejects a non-digit AI_REVIEW_TIMEOUT_MS", () => {
    expect(() => loadEnv({ ...complete, AI_REVIEW_TIMEOUT_MS: "soon" })).toThrow(
      /AI_REVIEW_TIMEOUT_MS/,
    )
  })

  test("defaults AI_REVIEW_HARNESS to opencode", () => {
    expect(loadEnv(complete).aiReviewHarness).toBe("opencode")
  })

  test("reads AI_REVIEW_HARNESS=claude and defaults its model to sonnet", () => {
    const env = loadEnv({ ...complete, AI_REVIEW_HARNESS: "claude" })
    expect(env.aiReviewHarness).toBe("claude")
    expect(env.aiReviewModel).toBe("sonnet")
  })

  test("an explicit AI_REVIEW_MODEL wins over the harness default", () => {
    const env = loadEnv({
      ...complete,
      AI_REVIEW_HARNESS: "claude",
      AI_REVIEW_MODEL: "claude-opus-4-6",
    })
    expect(env.aiReviewModel).toBe("claude-opus-4-6")
  })

  test("rejects an unrecognized AI_REVIEW_HARNESS", () => {
    expect(() => loadEnv({ ...complete, AI_REVIEW_HARNESS: "cursor" })).toThrow(/AI_REVIEW_HARNESS/)
  })
})
