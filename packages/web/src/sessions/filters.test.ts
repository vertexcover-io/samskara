import { describe, expect, test } from "vitest"
import { type SessionFilters, parseFilters, serializeFilters, sortSessions } from "./filters.js"

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

describe("SC16: a keyword round-trips through the URL", () => {
  test("?q=timeout parses with the keyword timeout, and serializing it back produces the same query string", () => {
    const filters = parseFilters(new URLSearchParams("q=timeout"))
    expect(filters.q).toBe("timeout")
    expect(serializeFilters(filters).toString()).toBe("q=timeout")
  })
})

describe("SC17: an empty keyword leaves no q in the URL", () => {
  test("a URL with q= (empty) parses with no keyword, and serializing it back carries no q", () => {
    const filters = parseFilters(new URLSearchParams("q="))
    expect(filters.q).toBeNull()
    expect(serializeFilters(filters).toString()).toBe("")
  })

  test("whitespace-only q parses as null, not as an empty string", () => {
    expect(parseFilters(new URLSearchParams("q=%20%20")).q).toBeNull()
  })
})

describe("SC18: the best-match sort keeps the server order", () => {
  test("sortSessions returns the exact same array reference when sort is best", () => {
    const sessions = [
      { lastActiveAt: "2026-01-01T00:00:00.000Z", tokensTotal: 10, projectName: "b" },
      { lastActiveAt: "2026-01-02T00:00:00.000Z", tokensTotal: 5, projectName: "a" },
    ]
    expect(sortSessions(sessions, "best")).toBe(sessions)
  })
})
