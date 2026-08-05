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
      artifactPreviewSandbox: true,
    })
  })

  test("the artifact preview sandbox is on unless a source explicitly turns it off", () => {
    // The safe path must not depend on anyone remembering to set this.
    expect(loadEnv(complete).artifactPreviewSandbox).toBe(true)
    expect(loadEnv({ ...complete, ARTIFACT_PREVIEW_SANDBOX: "on" }).artifactPreviewSandbox).toBe(
      true,
    )
    expect(loadEnv({ ...complete, ARTIFACT_PREVIEW_SANDBOX: "off" }).artifactPreviewSandbox).toBe(
      false,
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
})
