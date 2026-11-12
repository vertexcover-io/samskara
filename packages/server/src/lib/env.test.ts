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
      aiAgentSlots: 4,
      maxAttempts: 3,
      readerConcurrency: 4,
      learningsModel: "opencode-go/glm-5.3-flash",
      nightlyReview: {
        at: "01:00",
        timeZone: "Asia/Kolkata",
        limit: 10,
        quietHours: 6,
        pickWithinDays: 14,
        minNewUserMessages: 3,
      },
    })
  })

  test("SC1: unset nightly settings take the defaults", () => {
    expect(loadEnv(complete).nightlyReview).toEqual({
      at: "01:00",
      timeZone: "Asia/Kolkata",
      limit: 10,
      quietHours: 6,
      pickWithinDays: 14,
      minNewUserMessages: 3,
    })
  })

  test("SC2: set nightly settings are read", () => {
    const env = loadEnv({
      ...complete,
      NIGHTLY_REVIEW_TIME: "03:30",
      NIGHTLY_REVIEW_TIME_ZONE: "UTC",
      NIGHTLY_REVIEW_LIMIT: "4",
      NIGHTLY_QUIET_HOURS: "2",
      NIGHTLY_PICK_WITHIN_DAYS: "30",
      NIGHTLY_MIN_NEW_USER_MESSAGES: "5",
    })
    expect(env.nightlyReview).toEqual({
      at: "03:30",
      timeZone: "UTC",
      limit: 4,
      quietHours: 2,
      pickWithinDays: 30,
      minNewUserMessages: 5,
    })
  })

  test("SC3: a bad nightly setting stops the boot, naming the setting", () => {
    expect(() => loadEnv({ ...complete, NIGHTLY_REVIEW_TIME: "25:00" })).toThrow(
      /Invalid environment configuration: NIGHTLY_REVIEW_TIME$/,
    )
    expect(() => loadEnv({ ...complete, NIGHTLY_REVIEW_TIME_ZONE: "Mars/Base" })).toThrow(
      /Invalid environment configuration: NIGHTLY_REVIEW_TIME_ZONE/,
    )
    expect(() => loadEnv({ ...complete, NIGHTLY_REVIEW_LIMIT: "0" })).toThrow(
      /Invalid environment configuration: NIGHTLY_REVIEW_LIMIT/,
    )
  })

  test("the nightly limit is at most 25", () => {
    expect(loadEnv({ ...complete, NIGHTLY_REVIEW_LIMIT: "25" }).nightlyReview?.limit).toBe(25)
    for (const limit of ["26", "99999999999999999999"])
      expect(() => loadEnv({ ...complete, NIGHTLY_REVIEW_LIMIT: limit })).toThrow(
        /Invalid environment configuration: NIGHTLY_REVIEW_LIMIT/,
      )
  })

  test("an offset zone is refused, since Postgres reads its sign the other way round", () => {
    for (const offset of ["+05:30", "-08:00", "+0530"]) {
      expect(() => loadEnv({ ...complete, NIGHTLY_REVIEW_TIME_ZONE: offset })).toThrow(
        /Invalid environment configuration: NIGHTLY_REVIEW_TIME_ZONE/,
      )
    }
    for (const name of [
      "UTC",
      "Asia/Kolkata",
      "America/Ciudad_Juarez",
      "Etc/GMT+5",
      "Etc/GMT-14",
    ]) {
      expect(loadEnv({ ...complete, NIGHTLY_REVIEW_TIME_ZONE: name }).nightlyReview?.timeZone).toBe(
        name,
      )
    }
  })

  test("SC33: AI_AGENT_SLOTS is read with a default of 4", () => {
    expect(loadEnv(complete).aiAgentSlots).toBe(4)
    expect(loadEnv({ ...complete, AI_AGENT_SLOTS: "3" }).aiAgentSlots).toBe(3)
    expect(() => loadEnv({ ...complete, AI_AGENT_SLOTS: "0" })).toThrow(/AI_AGENT_SLOTS/)
    expect(() => loadEnv({ ...complete, AI_AGENT_SLOTS: "two" })).toThrow(/AI_AGENT_SLOTS/)
  })

  test("WORK_MAX_ATTEMPTS and AI_READER_CONCURRENCY are read with defaults of 3 and 4", () => {
    const env = loadEnv({ ...complete, WORK_MAX_ATTEMPTS: "5", AI_READER_CONCURRENCY: "2" })
    expect(env.maxAttempts).toBe(5)
    expect(env.readerConcurrency).toBe(2)
  })

  test("a bad nightly window or retry setting stops the boot, naming the setting", () => {
    const bad: ReadonlyArray<readonly [string, string]> = [
      ["NIGHTLY_QUIET_HOURS", "0"],
      ["NIGHTLY_QUIET_HOURS", "169"],
      ["NIGHTLY_QUIET_HOURS", "1.5"],
      ["NIGHTLY_PICK_WITHIN_DAYS", "0"],
      ["NIGHTLY_PICK_WITHIN_DAYS", "366"],
      ["NIGHTLY_MIN_NEW_USER_MESSAGES", "0"],
      ["NIGHTLY_MIN_NEW_USER_MESSAGES", "101"],
      ["WORK_MAX_ATTEMPTS", "0"],
      ["WORK_MAX_ATTEMPTS", "11"],
      ["AI_READER_CONCURRENCY", "0"],
      ["AI_READER_CONCURRENCY", "four"],
    ]
    for (const [key, value] of bad)
      expect(() => loadEnv({ ...complete, [key]: value }), `${key}=${value}`).toThrow(
        new RegExp(`Invalid environment configuration: ${key}$`),
      )
  })

  test("the top of each range is accepted", () => {
    const env = loadEnv({
      ...complete,
      NIGHTLY_QUIET_HOURS: "168",
      NIGHTLY_PICK_WITHIN_DAYS: "365",
      NIGHTLY_MIN_NEW_USER_MESSAGES: "100",
      WORK_MAX_ATTEMPTS: "10",
    })
    expect(env.nightlyReview).toMatchObject({
      quietHours: 168,
      pickWithinDays: 365,
      minNewUserMessages: 100,
    })
    expect(env.maxAttempts).toBe(10)
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

  test("SC7: the read-only GitHub token is read on its own, with or without a harness repo", () => {
    const env = loadEnv({ ...complete, LEARNINGS_HARNESS_GITHUB_TOKEN: "ghp_read" })
    expect(env.githubReadToken).toBe("ghp_read")
    expect(env.learningsHarness).toBeUndefined()
    expect(loadEnv(complete).githubReadToken).toBeUndefined()
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
