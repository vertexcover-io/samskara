import { afterEach, describe, expect, test, vi } from "vitest"
import type { Env } from "../lib/env.js"
import { createGithubClient } from "./github.js"

const env: Env = {
  githubClientId: "client-id",
  githubClientSecret: "client-secret",
  publicBaseUrl: "http://localhost:3000",
  webBaseUrl: "http://localhost:8000",
  cookieSecure: false,
  jwtSecret: "test-secret-value",
  jwtExpiresIn: "7d",
  superAdminLogins: [],
  aiReviewHarness: "opencode",
  aiReviewModel: "zai-coding-plan/glm-5.3-flash",
  aiReviewTimeoutMs: 600_000,
}

const orgsPage = (logins: ReadonlyArray<string>): Response =>
  new Response(JSON.stringify(logins.map((login) => ({ login }))), { status: 200 })

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("getOrgs", () => {
  const fullPage = (offset: number): ReadonlyArray<string> =>
    Array.from({ length: 100 }, (_, i) => `org-${offset + i}`)

  test.each([
    {
      name: "a user with 150 orgs across two pages gets all 150 in two requests",
      page: (n: string | null) => (n === "2" ? fullPage(100).slice(0, 50) : fullPage(0)),
      requests: 2,
      orgs: [...fullPage(0), ...fullPage(100).slice(0, 50)],
    },
    {
      name: "a single short page makes exactly one request and lowercases the logins",
      page: () => ["Acme"],
      requests: 1,
      orgs: ["acme"],
    },
    {
      name: "every page full stops after a capped 10 requests",
      page: () => fullPage(0),
      requests: 10,
      orgs: Array.from({ length: 10 }, () => fullPage(0)).flat(),
    },
  ])("$name", async ({ page, requests, orgs }) => {
    const fetch = vi.fn(async (url: string | URL) =>
      orgsPage(page(new URL(url).searchParams.get("page"))),
    )
    vi.stubGlobal("fetch", fetch)

    expect(await createGithubClient(env).getOrgs("token")).toEqual(orgs)
    expect(fetch).toHaveBeenCalledTimes(requests)
  })
})
