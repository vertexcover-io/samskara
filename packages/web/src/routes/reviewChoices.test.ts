import { describe, expect, test } from "vitest"
import { reviewChoices } from "./reviewChoices.js"

describe("reviewChoices", () => {
  test.each([
    {
      name: "a never-reviewed session offers Review only",
      state: { reviewed: false, newMessages: false, running: false },
      expected: [{ mode: "full", label: "Review" }],
    },
    {
      name: "a reviewed session with new messages offers Review new messages first, then Full review",
      state: { reviewed: true, newMessages: true, running: false },
      expected: [
        { mode: "newMessages", label: "Review new messages" },
        { mode: "full", label: "Full review" },
      ],
    },
    {
      name: "a reviewed session with nothing new offers Full review again only",
      state: { reviewed: true, newMessages: false, running: false },
      expected: [{ mode: "full", label: "Full review again" }],
    },
    {
      name: "a run waiting or running offers nothing, so the button is disabled",
      state: { reviewed: true, newMessages: true, running: true },
      expected: [],
    },
  ])("SC20: $name", ({ state, expected }) => {
    expect(reviewChoices(state)).toEqual(expected)
  })
})
