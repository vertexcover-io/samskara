import { describe, expect, test } from "vitest"
import type { SessionExportRecord } from "../export.js"
import { evidenceMessages, messageIdAt, problemExcerpt, recordsInReviewOrder } from "./excerpt.js"

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

describe("the messages behind one quote", () => {
  test("the cited messages, two on each side, each saying who wrote it and whether it is quoted", () => {
    const records = Array.from({ length: 10 }, (_, index) => rec(index, `m${index}`))
    const shown = evidenceMessages(records, { from: "msg-4", to: "msg-5", quote: "q", why: "w" })
    expect(shown.map((message) => [message.id, message.cited])).toEqual([
      ["msg-2", false],
      ["msg-3", false],
      ["msg-4", true],
      ["msg-5", true],
      ["msg-6", false],
      ["msg-7", false],
    ])
    expect(shown[2]).toMatchObject({ who: "assistant", text: "text of m4" })
  })

  test("a tool call says which tool, with its input and output", () => {
    const records = [
      rec(0, "t", {
        msgType: "toolCall",
        role: undefined,
        text: "",
        toolName: "Bash",
        status: "failure",
        input: "bun test",
        output: "1 failed",
      }),
    ]
    const [call] = evidenceMessages(records, { from: "msg-0", to: "msg-0", quote: "q", why: "w" })
    expect(call).toMatchObject({ who: "Bash, failure", input: "bun test", output: "1 failed" })
  })

  test("near the start or end of a session, it stops at the edge", () => {
    const records = Array.from({ length: 3 }, (_, index) => rec(index, `m${index}`))
    const shown = evidenceMessages(records, { from: "msg-0", to: "msg-2", quote: "q", why: "w" })
    expect(shown.map((message) => message.id)).toEqual(["msg-0", "msg-1", "msg-2"])
  })
})

describe("the messages behind one quote, in a busy session", () => {
  test("the messages around it come from the same agent, and empty records are left out", () => {
    const records = [
      rec(0, "a", { track: "agent:x", text: "x reads the code" }),
      rec(1, "b", { track: "agent:y", text: "y runs a command" }),
      rec(2, "c", { track: "agent:x", text: "x finds a bug" }),
      rec(3, "d", { track: "agent:x", msgType: "usage", text: "" }),
      rec(4, "e", { track: "agent:x", text: "I did not run anything" }),
      rec(5, "f", { track: "agent:y", text: "y again" }),
      rec(6, "g", { track: "agent:x", text: "x hands back" }),
    ]
    const shown = evidenceMessages(records, { from: "msg-4", to: "msg-4", quote: "q", why: "w" })
    expect(shown.map((message) => message.text)).toEqual([
      "x reads the code",
      "x finds a bug",
      "I did not run anything",
      "x hands back",
    ])
  })
})

describe("the quoted message itself", () => {
  test("is shown in full, never cut, and a tool call's text input is shown as plain lines", () => {
    const report = `Defects review.\n\n${"a long finding. ".repeat(400)}\n\nI did not run anything.`
    const records = [
      rec(0, "h", {
        msgType: "toolCall",
        role: undefined,
        text: "",
        toolName: "SubagentHandback",
        input: JSON.stringify({ message: report }),
      }),
    ]
    const [quoted] = evidenceMessages(records, { from: "msg-0", to: "msg-0", quote: "q", why: "w" })
    expect(quoted?.input).toBe(report)
  })

  test("a context message's command input is still cut like a reader's", () => {
    const records = [
      rec(0, "c", {
        msgType: "toolCall",
        role: undefined,
        text: "",
        toolName: "Bash",
        input: JSON.stringify({ command: "ls" }),
        output: "x".repeat(20_000),
      }),
      rec(1, "q", { text: "the quote" }),
    ]
    const [context] = evidenceMessages(records, {
      from: "msg-1",
      to: "msg-1",
      quote: "q",
      why: "w",
    })
    expect(context?.input).toBe("ls")
    expect((context?.output ?? "").length).toBeLessThan(20_000)
  })
})
