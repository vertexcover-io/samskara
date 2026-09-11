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
  localLoginSecret: "",
  localLoginLogin: "samskara-dev",
  aiReviewModel: "zai-coding-plan/glm-5.3",
  aiReviewHarness: "opencode",
  aiReviewTimeoutMs: 600000,
}

const orgsPage = (logins: ReadonlyArray<string>): Response =>
  new Response(JSON.stringify(logins.map((login) => ({ login }))), { status: 200 })

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("getOrgs", () => {
  test("a user with 150 orgs across two pages gets all 150", async () => {
    const firstPage = Array.from({ length: 100 }, (_, i) => `org-${i}`)
    const secondPage = Array.from({ length: 50 }, (_, i) => `org-${100 + i}`)
    const fetch = vi.fn(async (url: string | URL) => {
      const page = new URL(url).searchParams.get("page")
      return page === "2" ? orgsPage(secondPage) : orgsPage(firstPage)
    })
    vi.stubGlobal("fetch", fetch)

    const orgs = await createGithubClient(env).getOrgs("token")

    expect(orgs).toEqual([...firstPage, ...secondPage])
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  test("a single short page makes exactly one request", async () => {
    const fetch = vi.fn(async () => orgsPage(["Acme"]))
    vi.stubGlobal("fetch", fetch)

    const orgs = await createGithubClient(env).getOrgs("token")

    expect(orgs).toEqual(["acme"])
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  test("stops after a capped number of pages even if every page is full", async () => {
    const fetch = vi.fn(async () => orgsPage(Array.from({ length: 100 }, (_, i) => `org-${i}`)))
    vi.stubGlobal("fetch", fetch)

    const orgs = await createGithubClient(env).getOrgs("token")

    expect(fetch).toHaveBeenCalledTimes(10)
    expect(orgs).toHaveLength(1000)
  })
})
