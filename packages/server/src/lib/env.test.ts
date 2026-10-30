import { describe, expect, test } from "vitest"
import { loadEnv } from "./env.js"

const complete = {
  GITHUB_CLIENT_ID: "cid",
  GITHUB_CLIENT_SECRET: "secret",
  PUBLIC_BASE_URL: "http://localhost:3000",
  WEB_BASE_URL: "http://localhost:8000",
  COOKIE_SECURE: "false",
  JWT_SECRET: "jwt",
  OPENCODE_API_KEY: "oc-key",
}

const { OPENCODE_API_KEY: _noKey, ...noOpencodeKey } = complete
const { JWT_SECRET: _noSecret, ...noJwtSecret } = complete
const { WEB_BASE_URL: _noWeb, ...noWebBaseUrl } = complete
const noGithubApp = { ...complete, GITHUB_CLIENT_ID: "", GITHUB_CLIENT_SECRET: "" }

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
      aiReviewModel: "opencode-go/glm-5.3-flash",
      aiReviewTimeoutMs: 600_000,
      learningsModel: "opencode-go/glm-5.3-flash",
    })
  })

  test("requires the credential of the configured harness, not of every harness", () => {
    const env = loadEnv({
      ...noOpencodeKey,
      AI_REVIEW_HARNESS: "claude",
      CLAUDE_CODE_OAUTH_TOKEN: "tok",
    })
    expect(env.aiReviewHarness).toBe("claude")
    expect(env.aiReviewModel).toBe("sonnet")
  })

  test("accepts ANTHROPIC_API_KEY as claude's credential", () => {
    expect(() =>
      loadEnv({ ...noOpencodeKey, AI_REVIEW_HARNESS: "claude", ANTHROPIC_API_KEY: "sk-ant" }),
    ).not.toThrow()
  })

  test("LEARNINGS_MODEL: opus on claude unless set, the reviewer's model on opencode", () => {
    const { OPENCODE_API_KEY: _dropped, ...noKey } = complete
    const claude = { ...noKey, AI_REVIEW_HARNESS: "claude", CLAUDE_CODE_OAUTH_TOKEN: "tok" }
    expect(loadEnv(claude).learningsModel).toBe("opus")
    expect(loadEnv({ ...claude, LEARNINGS_MODEL: "sonnet" }).learningsModel).toBe("sonnet")
    expect(loadEnv(complete).learningsModel).toBe(loadEnv(complete).aiReviewModel)
    expect(() => loadEnv({ ...claude, LEARNINGS_MODEL: "opus; rm -rf /" })).toThrow()
  })

  test("the learning harness is a GitHub repo or a local checkout, never both", () => {
    expect(loadEnv(complete).learningsHarness).toBeUndefined()
    expect(loadEnv({ ...complete, LEARNINGS_HARNESS_PATH: "/srv/yok" }).learningsHarness).toEqual({
      path: "/srv/yok",
    })
    expect(
      loadEnv({ ...complete, LEARNINGS_HARNESS_REPO: "vertexcover-io/yok" }).learningsHarness,
    ).toEqual({ github: "vertexcover-io/yok" })
    expect(
      loadEnv({
        ...complete,
        LEARNINGS_HARNESS_REPO: "vertexcover-io/yok",
        LEARNINGS_HARNESS_GITHUB_TOKEN: "ghp_x",
      }).learningsHarness,
    ).toEqual({ github: "vertexcover-io/yok", token: "ghp_x" })
    expect(() =>
      loadEnv({
        ...complete,
        LEARNINGS_HARNESS_REPO: "vertexcover-io/yok",
        LEARNINGS_HARNESS_PATH: "/srv/yok",
      }),
    ).toThrow(/LEARNINGS_HARNESS_REPO/)
    expect(() =>
      loadEnv({ ...complete, LEARNINGS_HARNESS_REPO: "https://github.com/vertexcover-io/yok" }),
    ).toThrow(/LEARNINGS_HARNESS_REPO/)
  })

  test("a set LOCAL_LOGIN_SECRET makes the GitHub app optional - both keys may be blank", () => {
    const env = loadEnv({
      ...complete,
      GITHUB_CLIENT_ID: "",
      GITHUB_CLIENT_SECRET: "",
      LOCAL_LOGIN_SECRET: "open sesame",
    })
    expect(env.githubClientId).toBe("")
    expect(env.githubClientSecret).toBe("")
    expect(env.localLoginSecret).toBe("open sesame")
  })

  test.each([
    ["the configured harness has no credential", noOpencodeKey, /OPENCODE_API_KEY/],
    ["JWT_SECRET is absent", noJwtSecret, /JWT_SECRET/],
    ["GitHub keys are blank without LOCAL_LOGIN_SECRET", noGithubApp, /GITHUB_CLIENT_ID/],
    ["GitHub keys are blank without LOCAL_LOGIN_SECRET", noGithubApp, /GITHUB_CLIENT_SECRET/],
    [
      "only the GitHub client id is blank",
      { ...complete, GITHUB_CLIENT_ID: "" },
      /GITHUB_CLIENT_ID/,
    ],
  ])("refuses to start when %s, naming %s", (_case, source, missing) => {
    expect(() => loadEnv(source)).toThrow(missing)
  })

  test.each([
    [
      "AI_REVIEW_MODEL overrides the harness default",
      { ...complete, AI_REVIEW_MODEL: "opencode/glm-5.3" },
      { aiReviewModel: "opencode/glm-5.3" },
    ],
    [
      "LOCAL_LOGIN_SECRET and LOCAL_LOGIN_LOGIN are read verbatim",
      { ...complete, LOCAL_LOGIN_SECRET: "open sesame", LOCAL_LOGIN_LOGIN: "teammate" },
      { localLoginSecret: "open sesame", localLoginLogin: "teammate" },
    ],
    [
      "SUPER_ADMIN_LOGINS becomes a trimmed, lowercased list",
      { ...complete, SUPER_ADMIN_LOGINS: " Harit , riteshK ,, " },
      { superAdminLogins: ["harit", "riteshk"] },
    ],
    [
      "a blank SUPER_ADMIN_LOGINS is an empty list",
      { ...complete, SUPER_ADMIN_LOGINS: "  " },
      { superAdminLogins: [] },
    ],
    // Production sets PUBLIC_BASE_URL but not WEB_BASE_URL: the API and the UI are one origin,
    // since the server serves the built web app. A localhost fallback here silently sent every
    // post-login redirect to a machine the user is not on.
    [
      "WEB_BASE_URL falls back to PUBLIC_BASE_URL when absent",
      noWebBaseUrl,
      { webBaseUrl: "http://localhost:3000" },
    ],
    [
      "JWT_EXPIRES_IN overrides the 7d default",
      { ...complete, JWT_EXPIRES_IN: "1h" },
      { jwtExpiresIn: "1h" },
    ],
    [
      "COOKIE_SECURE=true is coerced to boolean true",
      { ...complete, COOKIE_SECURE: "true" },
      { cookieSecure: true },
    ],
  ])("%s", (_case, source, expected) => {
    expect(loadEnv(source)).toMatchObject(expected)
  })
})
