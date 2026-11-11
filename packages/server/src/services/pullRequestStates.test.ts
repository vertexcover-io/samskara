import { describe, expect, test, vi } from "vitest"
import type { PullRequestRef } from "../repositories/pullRequests.repo.js"
import { createPullRequestLookup, LOOKUP_BATCH } from "./pullRequestStates.js"

type RequestBody = {
  readonly query: string
  readonly variables: Record<string, string | number>
}

const refs = (count: number): ReadonlyArray<PullRequestRef> =>
  Array.from({ length: count }, (_, i) => ({
    id: `pr-${i}`,
    owner: "acme-owner",
    repo: `widget-${i}`,
    number: 1000 + i,
  }))

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })

const bodyOf = (init: RequestInit | undefined): RequestBody =>
  JSON.parse(String(init?.body)) as RequestBody

/** How many pull requests one request asked about: one `pN` variable each. */
const asked = (init: RequestInit | undefined): number =>
  Object.keys(bodyOf(init).variables).filter((key) => key.startsWith("p")).length

/** A GitHub that answers every pull request in the request as open. */
const allOpen = (init: RequestInit | undefined): Response =>
  json({
    data: Object.fromEntries(
      Array.from({ length: asked(init) }, (_, i) => [
        `pr${i}`,
        { pullRequest: { state: "OPEN", mergedAt: null, closedAt: null } },
      ]),
    ),
  })

describe("createPullRequestLookup", () => {
  test("SC8: without a token there is no lookup, and nothing is fetched", () => {
    const fakeFetch = vi.fn<typeof fetch>()

    expect(createPullRequestLookup(undefined, fakeFetch)).toBeUndefined()
    expect(fakeFetch).not.toHaveBeenCalled()
  })

  test("SC9: GitHub's answers become states and close times", async () => {
    const fakeFetch = vi.fn<typeof fetch>(async () =>
      json({
        data: {
          pr0: {
            pullRequest: {
              state: "MERGED",
              mergedAt: "2026-11-10T08:00:00Z",
              closedAt: "2026-11-10T08:00:00Z",
            },
          },
          pr1: {
            pullRequest: { state: "CLOSED", mergedAt: null, closedAt: "2026-11-09T12:30:00Z" },
          },
          pr2: { pullRequest: { state: "OPEN", mergedAt: null, closedAt: null } },
          pr3: { pullRequest: null },
        },
      }),
    )
    const lookup = createPullRequestLookup("t", fakeFetch)
    const prs = refs(4)

    const result = await lookup?.(prs)

    expect(result).toEqual({
      answers: [
        { id: "pr-0", state: "merged", closedAt: new Date("2026-11-10T08:00:00Z") },
        { id: "pr-1", state: "closed", closedAt: new Date("2026-11-09T12:30:00Z") },
        { id: "pr-2", state: "open", closedAt: null },
        { id: "pr-3", state: null, closedAt: null },
      ],
      failures: [],
    })
    expect(fakeFetch).toHaveBeenCalledTimes(1)
    const [url, init] = fakeFetch.mock.calls[0] ?? []
    expect(url).toBe("https://api.github.com/graphql")
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer t")
    const body = bodyOf(init)
    expect(body.variables).toMatchObject({ o0: "acme-owner", n0: "widget-0", p0: 1000 })
    expect(body.variables).toMatchObject({ o3: "acme-owner", n3: "widget-3", p3: 1003 })
    expect(body.query).not.toContain("acme-owner")
    expect(body.query).not.toContain("widget-")
    expect(body.query).not.toContain("1000")
  })

  test("SC10: 120 pull requests take 3 requests of at most 50", async () => {
    const fakeFetch = vi.fn<typeof fetch>(async (_url, init) => allOpen(init))
    const lookup = createPullRequestLookup("t", fakeFetch)

    const result = await lookup?.(refs(120))

    expect(LOOKUP_BATCH).toBe(50)
    expect(fakeFetch.mock.calls.map(([, init]) => asked(init))).toEqual([50, 50, 20])
    expect(result?.answers).toHaveLength(120)
    expect(result?.answers.map((a) => a.id)).toEqual(refs(120).map((pr) => pr.id))
    expect(result?.failures).toEqual([])
  })

  test.each([
    { label: "HTTP 502", fail: async () => json({ message: "Bad Gateway" }, 502) },
    {
      label: "a rejected fetch",
      fail: async (): Promise<Response> => {
        throw new TypeError("fetch failed")
      },
    },
  ])("SC11: a failed request ($label) costs only its own pull requests", async ({ fail }) => {
    let calls = 0
    const fakeFetch = vi.fn<typeof fetch>(async (_url, init) => {
      calls += 1
      return calls === 2 ? fail() : allOpen(init)
    })
    const lookup = createPullRequestLookup("t", fakeFetch)
    const prs = refs(120)

    const result = await lookup?.(prs)

    expect(fakeFetch).toHaveBeenCalledTimes(3)
    expect(result?.answers.map((a) => a.id)).toEqual(
      [...prs.slice(0, 50), ...prs.slice(100)].map((pr) => pr.id),
    )
    expect(result?.failures).toHaveLength(1)
  })

  test.each([
    { label: "HTTP 403", limit: () => json({ message: "API rate limit exceeded" }, 403) },
    { label: "HTTP 429", limit: () => json({ message: "Too Many Requests" }, 429) },
    {
      label: "HTTP 200 with no data and a RATE_LIMITED error",
      limit: () =>
        json({
          data: null,
          errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }],
        }),
    },
  ])(
    "a rate limit ($label) sends no further request and fails the ones not sent",
    async ({ limit }) => {
      let calls = 0
      const fakeFetch = vi.fn<typeof fetch>(async (_url, init) => {
        calls += 1
        return calls === 2 ? limit() : allOpen(init)
      })
      const lookup = createPullRequestLookup("t", fakeFetch)
      const prs = refs(170)

      const result = await lookup?.(prs)

      expect(fakeFetch).toHaveBeenCalledTimes(2)
      expect(result?.answers.map((a) => a.id)).toEqual(prs.slice(0, 50).map((pr) => pr.id))
      expect(result?.failures).toHaveLength(3)
    },
  )
})
