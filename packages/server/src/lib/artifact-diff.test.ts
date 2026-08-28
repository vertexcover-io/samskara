import { MAX_DIFF_BYTES } from "@samskara/core"
import { describe, expect, test } from "vitest"
import { renderBaseDiff } from "./artifact-diff.js"

describe("renderBaseDiff", () => {
  test("SC14: a base and its current content render as one whole-file patch", () => {
    const patch = renderBaseDiff("one\ntwo\nthree\n", "one\nTWO\nthree\n", "docs/notes.md")

    expect(patch).toContain("--- docs/notes.md")
    expect(patch).toContain("+++ docs/notes.md")
    expect(patch).toContain("-two")
    expect(patch).toContain("+TWO")
  })

  test("SC14: a line rewritten twice during the session shows only its net change", () => {
    const patch = renderBaseDiff(
      'const host = "localhost"\n',
      "const host = process.env.HOST\n",
      "src/config.ts",
    )

    expect(patch).toContain('-const host = "localhost"')
    expect(patch).toContain("+const host = process.env.HOST")
    expect(patch).not.toContain("0.0.0.0")
  })

  test("SC16: a whole-file patch past the size cap is refused rather than truncated", () => {
    const base = `${"a".repeat(MAX_DIFF_BYTES)}\n`
    const current = `${"b".repeat(MAX_DIFF_BYTES)}\n`

    expect(renderBaseDiff(base, current, "big.txt")).toBeNull()
  })

  test("a file whose content did not change renders a patch with no hunks in it", () => {
    const patch = renderBaseDiff("same\n", "same\n", "docs/notes.md")

    expect(patch).not.toBeNull()
    expect(patch).not.toContain("@@")
  })
})
