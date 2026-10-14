import { describe, expect, test } from "vitest"
import { fillGeneratedSecrets, missingCredentials } from "./setup.js"

describe("missingCredentials", () => {
  test.each([
    [
      "both GitHub keys when they are blank",
      "GITHUB_CLIENT_ID=\nGITHUB_CLIENT_SECRET=\nOPENCODE_API_KEY=k\n",
      ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"],
    ],
    [
      "nothing once both are filled",
      "GITHUB_CLIENT_ID=abc\nGITHUB_CLIENT_SECRET=def\nOPENCODE_API_KEY=k\n",
      [],
    ],
    [
      "an absent line the same as a blank one",
      "GITHUB_CLIENT_ID=abc\nOPENCODE_API_KEY=k\n",
      ["GITHUB_CLIENT_SECRET"],
    ],
    [
      "neither GitHub key when LOCAL_LOGIN_SECRET is set, since that is a way in of its own",
      "GITHUB_CLIENT_ID=\nGITHUB_CLIENT_SECRET=\nLOCAL_LOGIN_SECRET=open sesame\nOPENCODE_API_KEY=k\n",
      [],
    ],
    [
      "both GitHub keys when LOCAL_LOGIN_SECRET is blank",
      "GITHUB_CLIENT_ID=\nLOCAL_LOGIN_SECRET=\nOPENCODE_API_KEY=k\n",
      ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"],
    ],
    [
      "the review credential the server will refuse to boot without",
      "GITHUB_CLIENT_ID=a\nGITHUB_CLIENT_SECRET=b\n",
      ["OPENCODE_API_KEY"],
    ],
    [
      "claude's credential when claude is the configured harness",
      "GITHUB_CLIENT_ID=a\nGITHUB_CLIENT_SECRET=b\nAI_REVIEW_HARNESS=claude\n",
      ["CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY"],
    ],
  ])("names %s", (_case, envText, missing) => {
    expect(missingCredentials(envText)).toEqual(missing)
  })
})

describe("fillGeneratedSecrets", () => {
  test("fills a blank JWT_SECRET so setup needs no openssl step", () => {
    const result = fillGeneratedSecrets("JWT_SECRET=\n", () => "generated")
    expect(result.generated).toEqual(["JWT_SECRET"])
    expect(result.text).toBe("JWT_SECRET=generated\n")
  })

  test("leaves an existing secret alone -- rotating it would void live cookies", () => {
    const result = fillGeneratedSecrets("JWT_SECRET=already-set\n", () => "generated")
    expect(result.generated).toEqual([])
    expect(result.text).toBe("JWT_SECRET=already-set\n")
  })
})
