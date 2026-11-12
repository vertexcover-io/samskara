import { describe, expect, test } from "vitest"
import {
  MAX_BATCH_SESSIONS,
  queuedMessage,
  refusalMessage,
  toggled,
  withPage,
} from "./reviewBatch.js"

const ids = (count: number, prefix = "s"): ReadonlyArray<string> =>
  Array.from({ length: count }, (_, index) => `${prefix}-${index}`)

describe("review batch selection", () => {
  test("SC22: the queued note names what happened", () => {
    expect(queuedMessage({ queued: 3, skipped: 1, notAllowed: ["a", "b"], fixRunsQueued: 2 })).toBe(
      "Queued 3 sessions for review. Fixes will be found in 2 projects once the reviews finish. 1 session had nothing new or a review already running. 2 sessions you cannot edit.",
    )
    expect(queuedMessage({ queued: 1, skipped: 0, notAllowed: [], fixRunsQueued: 0 })).toBe(
      "Queued 1 session for review.",
    )
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
    expect(refusalMessage({ kind: "server", code: "harnessUnauthenticated", message: "400" })).toBe(
      "The reviewer has no key on this server.",
    )
    expect(
      refusalMessage({ kind: "network", code: null, message: "The server is unreachable." }),
    ).toBe("The server is unreachable.")
  })
})
