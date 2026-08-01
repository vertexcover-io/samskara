import { describe, expect, test } from "vitest"
import {
  type SessionFilters,
  parseFilters,
  serializeFilters,
  sortSessions,
  withQuery,
} from "./filters.js"

const roundTrip = (filters: SessionFilters): SessionFilters =>
  parseFilters(serializeFilters(filters))

describe("S16: filters survive a serialize/parse round trip and cleared filters leave no query noise", () => {
  const cases: ReadonlyArray<readonly [string, SessionFilters]> = [
    [
      "fully cleared",
      { project: null, user: null, range: "all", from: null, to: null, sort: "recent", q: null },
    ],
    [
      "project only",
      {
        project: "samskara",
        user: null,
        range: "all",
        from: null,
        to: null,
        sort: "recent",
        q: null,
      },
    ],
    [
      "user only",
      { project: null, user: "maya", range: "all", from: null, to: null, sort: "recent", q: null },
    ],
    [
      "range only",
      { project: null, user: null, range: "week", from: null, to: null, sort: "recent", q: null },
    ],
    [
      "all three set",
      {
        project: "samskara",
        user: "maya",
        range: "month",
        from: null,
        to: null,
        sort: "recent",
        q: null,
      },
    ],
    [
      "slug needing encoding",
      {
        project: "a b/c",
        user: "o'brien",
        range: "today",
        from: null,
        to: null,
        sort: "recent",
        q: null,
      },
    ],
    [
      "a search query with relevance sort",
      {
        project: null,
        user: null,
        range: "all",
        from: null,
        to: null,
        sort: "relevance",
        q: "memory leak",
      },
    ],
  ]

  test.each(cases)("%s deep-equals itself after a round trip", (_label, filters) => {
    expect(roundTrip(filters)).toEqual(filters)
  })

  test("a fully cleared filter set serializes to an empty query string - not project=&user=&range=all", () => {
    expect(
      serializeFilters({
        project: null,
        user: null,
        range: "all",
        from: null,
        to: null,
        sort: "recent",
        q: null,
      }).toString(),
    ).toBe("")
  })

  test("only the non-default fields appear in the query string", () => {
    const params = serializeFilters({
      project: "samskara",
      user: null,
      range: "week",
      from: null,
      to: null,
      sort: "recent",
      q: null,
    })
    expect(params.toString()).toBe("project=samskara&range=week")
  })
})

describe("S17: unrecognized and blank query values fall back to their defaults", () => {
  test("range=banana parses as all - not as banana or undefined", () => {
    expect(parseFilters(new URLSearchParams("range=banana")).range).toBe("all")
  })

  test("a missing range parses as all", () => {
    expect(parseFilters(new URLSearchParams("")).range).toBe("all")
  })

  test.each(["today", "week", "month", "all"] as const)("range=%s is preserved", (range) => {
    expect(parseFilters(new URLSearchParams(`range=${range}`)).range).toBe(range)
  })

  test("whitespace-only project and user parse as null - not as empty strings", () => {
    const filters = parseFilters(new URLSearchParams("project=%20%20&user="))
    expect(filters.project).toBeNull()
    expect(filters.user).toBeNull()
  })

  test("surrounding whitespace is trimmed off project and user", () => {
    const filters = parseFilters(new URLSearchParams("project=%20samskara%20&user=%20maya"))
    expect(filters).toEqual({
      project: "samskara",
      user: "maya",
      range: "all",
      from: null,
      to: null,
      sort: "recent",
      q: null,
    })
  })
})

describe("D19: relevance is a recognized sort, and q round-trips through the URL", () => {
  test("sort=relevance is preserved, not reset to recent", () => {
    expect(parseFilters(new URLSearchParams("sort=relevance")).sort).toBe("relevance")
  })

  test("q survives the round trip and is trimmed", () => {
    const filters = parseFilters(new URLSearchParams("q=%20memory%20leak%20"))
    expect(filters.q).toBe("memory leak")
  })

  test("a blank q parses as null, not an empty string", () => {
    expect(parseFilters(new URLSearchParams("q=%20%20")).q).toBeNull()
  })

  test("a null q is omitted from the serialized query string", () => {
    expect(
      serializeFilters({
        project: null,
        user: null,
        range: "all",
        from: null,
        to: null,
        sort: "recent",
        q: null,
      }).toString(),
    ).toBe("")
  })
})

describe("correction 1: sortSessions leaves the server's relevance order untouched", () => {
  const rows = [
    { lastActiveAt: "2026-01-01T00:00:00Z", tokensTotal: 10, projectName: "Z" },
    { lastActiveAt: "2026-03-01T00:00:00Z", tokensTotal: 1, projectName: "A" },
    { lastActiveAt: "2026-02-01T00:00:00Z", tokensTotal: 5, projectName: "M" },
  ]

  test("sortSessions(rows, 'relevance') returns the same array order it was given", () => {
    expect(sortSessions(rows, "relevance")).toEqual(rows)
  })

  test("every other sort still reorders, so relevance is not silently a no-op sort", () => {
    expect(sortSessions(rows, "recent")).not.toEqual(rows)
  })
})

describe("withQuery: typing a search flips the effective sort, clearing it restores recency", () => {
  const base: SessionFilters = {
    project: null,
    user: null,
    range: "all",
    from: null,
    to: null,
    sort: "recent",
    q: null,
  }

  test("typing into an empty box while sorted by recent switches to relevance", () => {
    expect(withQuery(base, "memory leak")).toEqual({
      ...base,
      q: "memory leak",
      sort: "relevance",
    })
  })

  test("clearing the box while sorted by relevance restores recent", () => {
    const searching: SessionFilters = { ...base, q: "memory leak", sort: "relevance" }
    expect(withQuery(searching, "")).toEqual({ ...base, q: null, sort: "recent" })
  })

  test("a sort the user picked explicitly (not recent) is left alone when a query starts", () => {
    const sortedByTokens: SessionFilters = { ...base, sort: "tokens" }
    expect(withQuery(sortedByTokens, "memory leak")).toEqual({
      ...sortedByTokens,
      q: "memory leak",
      sort: "tokens",
    })
  })

  test("blank input trims to a null query", () => {
    expect(withQuery(base, "   ").q).toBeNull()
  })
})
