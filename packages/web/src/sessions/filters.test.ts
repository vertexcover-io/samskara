import { describe, expect, test } from "vitest"
import { EMPTY_FILTERS, changedFilters, parseFilters, serializeFilters } from "./filters.js"

const roundTrip = (filters = EMPTY_FILTERS) => parseFilters(serializeFilters(filters))

describe("session filter URLs", () => {
  test("round-trips every server query parameter and URL-encodes exact values", () => {
    const filters = {
      ...EMPTY_FILTERS,
      q: 'auth "release guard"',
      project: "a b/c",
      user: "o'brien",
      repo: "8af8c0ae-fc61-4471-9c5e-7f252f1425e3",
      branch: "feat/Release Case",
      pr: "42",
      commit: "ABCDEF0123456",
      range: "custom" as const,
      from: "2026-08-01",
      to: "2026-08-20",
      tz: "America/New_York",
      sort: "relevance" as const,
      page: 3,
    }

    expect(roundTrip(filters)).toEqual({ ...filters, commit: "abcdef0123456" })
    expect(serializeFilters(filters).toString()).toContain("branch=feat%2FRelease+Case")
  })

  test("omits contextual defaults and all cleared values", () => {
    expect(serializeFilters(EMPTY_FILTERS).toString()).toBe("")
    expect(serializeFilters({ ...EMPTY_FILTERS, range: "today", tz: "UTC" }).toString()).toBe(
      "range=today&tz=UTC",
    )
  })

  test("preserves invalid structured values so the API can explain them", () => {
    expect(parseFilters(new URLSearchParams("pr=001&commit=not-a-sha&branch=%20%20")).pr).toBe(
      "001",
    )
    expect(parseFilters(new URLSearchParams("pr=001&commit=not-a-sha&branch=%20%20")).commit).toBe(
      "not-a-sha",
    )
    expect(parseFilters(new URLSearchParams("pr=001&commit=not-a-sha&branch=%20%20")).branch).toBe(
      "  ",
    )
  })

  test("defaults an active q to relevance, then clearing q removes relevance", () => {
    expect(parseFilters(new URLSearchParams("q=auth")).sort).toBe("relevance")
    expect(
      changedFilters({ ...EMPTY_FILTERS, q: "auth", sort: "relevance", page: 3 }, { q: null }),
    ).toEqual(EMPTY_FILTERS)
  })

  test("every result predicate and sort change resets the page", () => {
    const pageThree = { ...EMPTY_FILTERS, q: "auth", page: 3 }
    expect(changedFilters(pageThree, { branch: "main" }).page).toBe(1)
    expect(changedFilters(pageThree, { sort: "tokens" }).page).toBe(1)
  })

  test("uses a safe first page for malformed page values", () => {
    expect(parseFilters(new URLSearchParams("page=0")).page).toBe(1)
    expect(parseFilters(new URLSearchParams("page=1.5")).page).toBe(1)
    expect(parseFilters(new URLSearchParams("page=4")).page).toBe(4)
  })
})
