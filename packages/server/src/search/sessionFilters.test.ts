import { describe, expect, test } from "vitest"
import { paginate } from "./sessionFilters.js"

describe("paginate", () => {
  test("SC14: every page count equals the total divided by the limit, rounded up", () => {
    expect(paginate(0, 1, 50)).toEqual({ page: 1, limit: 50, total: 0, totalPages: 0 })
    expect(paginate(1, 1, 50)).toEqual({ page: 1, limit: 50, total: 1, totalPages: 1 })
    expect(paginate(50, 1, 50)).toEqual({ page: 1, limit: 50, total: 50, totalPages: 1 })
    expect(paginate(51, 1, 50)).toEqual({ page: 1, limit: 50, total: 51, totalPages: 2 })
    expect(paginate(51, 2, 50)).toEqual({ page: 2, limit: 50, total: 51, totalPages: 2 })
  })
})
