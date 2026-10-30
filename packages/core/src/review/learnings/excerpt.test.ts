import { describe, expect, test } from "vitest"
import type { SessionExportRecord } from "../export.js"
import { messageIdAt, problemExcerpt, recordsInReviewOrder } from "./excerpt.js"

const rec = (
  seq: number,
  sourceId: string,
  fields: Partial<SessionExportRecord> = {},
): SessionExportRecord => ({
  seq,
  id: `msg-${seq}`,
  sourceId,
  msgType: "message",
  role: "assistant",
  track: "main",
  text: `text of ${sourceId}`,
  ...fields,
})

describe("evidence excerpts", () => {
  test("LE1: records are put back in the order the review numbered them", () => {
    const fresh = [rec(0, "a"), rec(1, "c"), rec(2, "b")]
    const ordered = recordsInReviewOrder(fresh, ["a", "b", "c", null])
    expect(ordered.map((record) => [record.id, record.text])).toEqual([
      ["msg-0", "text of a"],
      ["msg-1", "text of b"],
      ["msg-2", "text of c"],
      ["msg-3", ""],
    ])
  })

  test("LE2: an excerpt is the evidence line, then the cited records with 3 on each side", () => {
    const records = Array.from({ length: 12 }, (_, index) => rec(index, `m${index}`))
    const text = problemExcerpt(records, [
      { from: "msg-5", to: "msg-6", quote: "text of m5", why: "said done early" },
    ])
    expect(text.split("\n")[0]).toBe('msg-5 to msg-6 — "text of m5" — said done early')
    expect(text).toContain("[msg-2] assistant:")
    expect(text).toContain("[msg-9] assistant:")
    expect(text).not.toContain("[msg-1]")
    expect(text).not.toContain("[msg-10]")
  })

  test("LE3: tool records are cut like a reader's: a call that worked keeps only its signal lines", () => {
    const records = [
      rec(0, "t", {
        msgType: "toolCall",
        role: undefined,
        text: undefined,
        toolName: "Bash",
        status: "success",
        input: "npm test",
        output: `${"ok line\n".repeat(400)}WARNING: deprecated flag\n`,
      }),
    ]
    const text = problemExcerpt(records, [
      { from: "msg-0", to: "msg-0", quote: "npm test", why: "x" },
    ])
    expect(text).toContain("[msg-0] Bash, success:")
    expect(text).toContain("WARNING: deprecated flag")
    expect(text).not.toContain("ok line\nok line")
  })
})

describe("messageIdAt", () => {
  test.each([
    [["a", null, "c"], "msg-0", "a"],
    [["a", null, "c"], "msg-1", null],
    [["a", null, "c"], "msg-5", null],
    [["a", null, "c"], "msg-x", null],
    [null, "msg-0", null],
  ])(
    "SC16: recordIds %j at %s is %s — a gone message, an id outside the list or no saved order is null",
    (recordIds, alias, expected) => {
      expect(messageIdAt(recordIds, alias)).toBe(expected)
    },
  )
})
