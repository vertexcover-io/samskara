import { describe, expect, test } from "vitest"
import { fuseRrf } from "./fusion.js"

describe("fuseRrf", () => {
  test("D14: fixed rank positions produce hand-computed scores at k=60", () => {
    const result = fuseRrf([{ ids: ["a", "b"], weight: 1 }], 60)

    expect(result.get("a")).toBeCloseTo(1 / 61)
    expect(result.get("b")).toBeCloseTo(1 / 62)
  })

  test("an id in two lists outscores an id at the same rank in one", () => {
    const result = fuseRrf(
      [
        { ids: ["shared", "solo"], weight: 1 },
        { ids: ["shared"], weight: 1 },
      ],
      60,
    )

    expect(result.get("shared")).toBeGreaterThan(result.get("solo") as number)
  })

  test("D15: a body hit at rank 1 outranks a title hit far down its list, despite the title list's heavier weight", () => {
    const titleList = Array.from({ length: 100 }, (_, i) =>
      i === 99 ? "title-chunk" : `filler-${i}`,
    )
    const result = fuseRrf(
      [
        { ids: ["body-chunk"], weight: 1 },
        { ids: titleList, weight: 2 },
      ],
      60,
    )

    expect(result.get("body-chunk")).toBeGreaterThan(result.get("title-chunk") as number)
  })

  test("an empty list contributes nothing and does not divide by zero", () => {
    const result = fuseRrf(
      [
        { ids: [], weight: 5 },
        { ids: ["only"], weight: 1 },
      ],
      60,
    )

    expect(result.size).toBe(1)
    expect(result.get("only")).toBeCloseTo(1 / 61)
  })
})
