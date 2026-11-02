import { describe, expect, test } from "vitest"
import {
  estimateMinutes,
  MAX_BATCH_SESSIONS,
  refusalMessage,
  toggled,
  withPage,
} from "./reviewBatch.js"

const ids = (count: number, prefix = "s"): ReadonlyArray<string> =>
  Array.from({ length: count }, (_, index) => `${prefix}-${index}`)

describe("review batch selection", () => {
  test("SC17: the estimate is about 3 minutes per session over 3 lanes, plus 5 for fixes", () => {
    expect([0, 1, 2, 10, 50].map(estimateMinutes)).toEqual([0, 6, 7, 15, 55])
  })

  test("SC18: selecting never goes past 50, and toggling a selected id removes it", () => {
    const full = new Set(ids(MAX_BATCH_SESSIONS))
    expect(toggled(full, "extra").size).toBe(50)
    expect(toggled(full, "extra").has("extra")).toBe(false)
    expect(withPage(full, ids(10, "new"), true).size).toBe(50)
    expect(toggled(full, "s-3").has("s-3")).toBe(false)
    expect(toggled(full, "s-3").size).toBe(49)
  })

  test("a page is added to picks from other pages, and clearing it keeps those picks", () => {
    const picked = withPage(new Set(["other"]), ["a", "b"], true)
    expect([...picked].sort()).toEqual(["a", "b", "other"])
    expect([...withPage(picked, ["a", "b"], false)]).toEqual(["other"])
  })

  test("a refusal reads in plain words, and an unknown one falls back to the server's message", () => {
    expect(
      refusalMessage({ kind: "server", code: "reviewBatchAlreadyRunning", message: "409" }),
    ).toBe("A review is already running. Wait for it to finish.")
    expect(
      refusalMessage({ kind: "network", code: null, message: "The server is unreachable." }),
    ).toBe("The server is unreachable.")
  })
})
