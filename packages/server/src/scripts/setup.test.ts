import { describe, expect, test } from "vitest"
import { fillGeneratedSecrets, missingCredentials } from "./setup.js"

describe("missingCredentials", () => {
  test("names the keys the OAuth app has to supply", () => {
    expect(missingCredentials("GITHUB_CLIENT_ID=\nGITHUB_CLIENT_SECRET=\n")).toEqual([
      "GITHUB_CLIENT_ID",
      "GITHUB_CLIENT_SECRET",
    ])
  })

  test("says nothing is missing once both are filled", () => {
    expect(missingCredentials("GITHUB_CLIENT_ID=abc\nGITHUB_CLIENT_SECRET=def\n")).toEqual([])
  })

  test("treats an absent line the same as a blank one", () => {
    expect(missingCredentials("GITHUB_CLIENT_ID=abc\n")).toEqual(["GITHUB_CLIENT_SECRET"])
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
