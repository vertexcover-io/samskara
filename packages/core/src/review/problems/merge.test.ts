import { describe, expect, test } from "vitest"
import type { HarnessRunInput, HarnessRunner } from "../runner.js"
import { BASE_REVIEW_INSTRUCTIONS } from "./contract.js"
import { MAX_MERGED_CHARS, mergeReviewPrompt } from "./merge.js"

const reply = (merged: string, changes = "- Changed Step 1: x"): string =>
  `Done.\n<<<MERGED\n${merged}\nMERGED>>>\n<<<CHANGES\n${changes}\nCHANGES>>>\n`

const model = (stdout: string, seen?: (input: HarnessRunInput) => void): HarnessRunner => ({
  run: async (input) => {
    seen?.(input)
    return { stdout, firstByteMs: 1 }
  },
})

describe("mergeReviewPrompt", () => {
  test("MG1: one call with no tools sees our base and the user's prompt, and its two parts come back", async () => {
    let input: HarnessRunInput | undefined
    const result = await mergeReviewPrompt(
      "Ignore gaps under 10 minutes.",
      model(reply("# How to review\n\nmerged", "- Changed Step 1: gaps over 10 minutes"), (i) => {
        input = i
      }),
    )
    expect(input?.oneShot).toBe(true)
    expect(input?.prompt).toContain(`<<<BASE\n${BASE_REVIEW_INSTRUCTIONS}\nBASE>>>`)
    expect(input?.prompt).toContain("<<<USER\nIgnore gaps under 10 minutes.\nUSER>>>")
    expect(result).toEqual({
      merged: "# How to review\n\nmerged\n",
      changes: "- Changed Step 1: gaps over 10 minutes",
    })
  })

  test("MG2: no merged part, or one past the size limit, is an error", async () => {
    await expect(mergeReviewPrompt("x", model("I merged it."))).rejects.toThrow(
      "did not reply with a merged prompt",
    )
    await expect(mergeReviewPrompt("x", model(reply("  ")))).rejects.toThrow(
      "did not reply with a merged prompt",
    )
    await expect(
      mergeReviewPrompt("x", model(reply("y".repeat(MAX_MERGED_CHARS + 1)))),
    ).rejects.toThrow("longer than")
  })

  test("MG3: a merge whose Extra fields are not simple names fails, rather than dropping every problem later", async () => {
    await expect(
      mergeReviewPrompt("x", model(reply("# How\n\n## Extra fields\n\n- the stage it was in: x"))),
    ).rejects.toThrow("not a field name")
  })

  test("MG4: a reply with no changes part still merges, with no changes listed", async () => {
    const result = await mergeReviewPrompt("x", model("<<<MERGED\n# How\nMERGED>>>"))
    expect(result).toEqual({ merged: "# How\n", changes: "" })
  })
})
