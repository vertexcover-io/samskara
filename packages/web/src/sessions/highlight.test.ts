import { describe, expect, test } from "vitest"
import { MATCH_END, MATCH_START, splitHighlights } from "./highlight.js"

const wrap = (text: string) => `${MATCH_START}${text}${MATCH_END}`

describe("splitHighlights", () => {
  test("a delimited term becomes a matched segment between its unmatched neighbours", () => {
    expect(splitHighlights(`the ${wrap("migration")} failed`)).toEqual([
      { text: "the ", match: false, start: 0 },
      { text: "migration", match: true, start: 5 },
      { text: " failed", match: false, start: 15 },
    ])
  })

  test("several matches in one snippet each become their own segment", () => {
    const segments = splitHighlights(`${wrap("memory")} and ${wrap("leak")}`)
    expect(segments.filter((s) => s.match).map((s) => s.text)).toEqual(["memory", "leak"])
  })

  test("a snippet with no match is a single unmatched segment", () => {
    expect(splitHighlights("nothing marked here")).toEqual([
      { text: "nothing marked here", match: false, start: 0 },
    ])
  })

  test("an unpaired delimiter is kept as ordinary text, never an unterminated match", () => {
    // A snippet is a fragment cut from a larger document, so a match can straddle the cut.
    // Highlighting to the end of the line would be worse than not highlighting at all.
    const segments = splitHighlights(`trailing ${MATCH_START}open`)
    expect(segments.every((s) => !s.match)).toBe(true)
    expect(segments.map((s) => s.text).join("")).toContain("open")
  })

  test("markup in the content stays text -- it is never treated as a delimiter", () => {
    const segments = splitHighlights(`<script>alert(1)</script> ${wrap("hit")}`)
    expect(segments[0]).toMatchObject({ text: "<script>alert(1)</script> ", match: false })
    expect(segments[1]).toMatchObject({ text: "hit", match: true })
  })

  test("an empty snippet produces no segments", () => {
    expect(splitHighlights("")).toEqual([])
  })
})
