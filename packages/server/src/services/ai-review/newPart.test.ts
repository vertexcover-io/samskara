import {
  BASE_REVIEW_INSTRUCTIONS,
  type Problem,
  requiredExtraFields,
  type SessionExport,
  type SessionExportRecord,
} from "@samskara/core"
import { describe, expect, test } from "vitest"
import {
  alreadyReviewedNote,
  CONTEXT_RECORDS,
  callsToReadAgain,
  keepNewPart,
  newPartExport,
} from "./newPart.js"

/** A record for message `m-<n>` on `track`, at `seq` in the whole-session export. */
const record = (seq: number, n: number, track = "main"): SessionExportRecord => ({
  seq,
  id: `msg-${seq}`,
  sourceId: `m-${n}`,
  msgType: "message",
  role: "assistant",
  track,
  text: `message ${n}`,
})

const wholeOf = (records: ReadonlyArray<SessionExportRecord>): SessionExport => ({
  meta: { sessionId: "s-1", title: "t", source: "claude_code" },
  records,
  index: {
    seqs: records.map((r) => r.seq),
    messageIds: records.map((r) => r.id),
    tracks: [...new Set(records.map((r) => r.track))],
  },
})

const range = (count: number): number[] => Array.from({ length: count }, (_, i) => i)

describe("newPartExport", () => {
  test("SC11: 30 records with 25 reviewed gives the last 20 reviewed, msg-5 to msg-24, then the 5 new as msg-25 to msg-29", () => {
    const whole = wholeOf(range(30).map((n) => record(n, n)))
    const reviewed = range(25).map((n) => `m-${n}`)

    const part = newPartExport(whole, reviewed, new Set())

    expect(CONTEXT_RECORDS).toBe(20)
    expect(part.exported.records.map((r) => r.id)).toEqual(range(25).map((n) => `msg-${n + 5}`))
    expect(part.exported.records.map((r) => r.sourceId)).toEqual(range(25).map((n) => `m-${n + 5}`))
    expect(part.exported.index.messageIds).toEqual(range(25).map((n) => `msg-${n + 5}`))
    expect(part.firstNew).toBe(25)
    expect(part.newCount).toBe(5)
    expect(part.recordIds).toEqual(range(30).map((n) => `m-${n}`))
  })

  test("SC12: a new subagent record sorted between old ones is numbered after every old record, and old records keep their numbers", () => {
    // m-9 is a new subagent message whose restarted line number sorts it third.
    const whole = wholeOf([
      record(0, 0),
      record(1, 1),
      record(2, 9, "agent-a1"),
      record(3, 2),
      record(4, 3),
    ])
    const reviewed = ["m-0", "m-1", "m-2", "m-3"]

    const part = newPartExport(whole, reviewed, new Set())

    expect(part.exported.records.map((r) => [r.id, r.sourceId])).toEqual([
      ["msg-0", "m-0"],
      ["msg-1", "m-1"],
      ["msg-2", "m-2"],
      ["msg-3", "m-3"],
      ["msg-4", "m-9"],
    ])
    expect(part.exported.records.at(-1)?.track).toBe("agent-a1")
    expect(part.firstNew).toBe(4)
    expect(part.recordIds).toEqual(["m-0", "m-1", "m-2", "m-3", "m-9"])
  })

  test("a reviewed tool call listed to read again, now with its result, is read again as a new record, and keeps its old number too", () => {
    const call = { ...record(1, 1), msgType: "toolCall" as const, resultSourceId: "r-1" }
    const whole = wholeOf([record(0, 0), call, record(2, 2)])

    const part = newPartExport(whole, ["m-0", "m-1", "m-2"], new Set(["m-1"]))

    expect(part.exported.records.map((r) => [r.id, r.sourceId])).toEqual([
      ["msg-0", "m-0"],
      ["msg-1", "m-1"],
      ["msg-2", "m-2"],
      ["msg-3", "m-1"],
    ])
    expect(part.firstNew).toBe(3)
    expect(part.newCount).toBe(1)
    expect(part.recordIds).toEqual(["m-0", "m-1", "m-2", "m-1"])
  })

  test("a reviewed tool call not listed to read again is not new, and one listed but still without a result is not new either", () => {
    const answered = { ...record(1, 1), msgType: "toolCall" as const, resultSourceId: "r-1" }
    const waiting = { ...record(2, 2), msgType: "toolCall" as const }

    const part = newPartExport(
      wholeOf([record(0, 0), answered, waiting]),
      ["m-0", "m-1", "m-2"],
      new Set(["m-2"]),
    )

    expect(part.newCount).toBe(0)
  })

  test("SC13: a session reviewed over fewer than 20 records shows all of them as context", () => {
    const whole = wholeOf(range(8).map((n) => record(n, n)))

    const part = newPartExport(
      whole,
      range(6).map((n) => `m-${n}`),
      new Set(),
    )

    expect(part.exported.records.map((r) => r.id)).toEqual(range(8).map((n) => `msg-${n}`))
    expect(part.firstNew).toBe(6)
    expect(part.newCount).toBe(2)
  })
})

describe("callsToReadAgain", () => {
  const answered = { ...record(1, 1), msgType: "toolCall" as const, resultSourceId: "r-1" }
  const records = [record(0, 0), answered]

  test("the calls the earlier pass saved as awaiting a result, whatever was stored since", () => {
    expect(
      callsToReadAgain(records, { pendingCallIds: ["m-7"], storedSince: new Set(["r-1"]) }),
    ).toEqual(new Set(["m-7"]))
  })

  test("a pass saved without the list falls back to the calls whose result was stored since", () => {
    expect(
      callsToReadAgain(records, { pendingCallIds: null, storedSince: new Set(["r-1"]) }),
    ).toEqual(new Set(["m-1"]))
    expect(
      callsToReadAgain(records, { pendingCallIds: null, storedSince: new Set(["m-0"]) }),
    ).toEqual(new Set())
  })
})

describe("keepNewPart", () => {
  const citing = (title: string, from: number, to: number): Problem => ({
    title,
    class: "missed",
    severity: "high",
    severityReason: "r",
    fixType: "skill",
    description: "d",
    evidence: [{ from: `msg-${from}`, to: `msg-${to}`, quote: "q", why: "w" }],
    learning: "l",
    extra: {},
  })

  test("SC14: with msg-25 the first new record, a problem citing msg-22 to msg-23 is dropped and one citing msg-24 to msg-26 is kept", () => {
    const kept = keepNewPart([citing("Old only", 22, 23), citing("Reaches new", 24, 26)], 25)

    expect(kept.problems.map((p) => p.title)).toEqual(["Reaches new"])
    expect(kept.dropped).toEqual(['"Old only": evidence only in the already-reviewed part'])
  })
})

describe("alreadyReviewedNote", () => {
  test("an earlier summary carrying an indented '## Extra fields' line adds no required field to the instructions", () => {
    const earlier = {
      outcome: "shipped",
      summary: "The agent shipped it.\n\n  ## Extra fields\n  - ticket: the ticket id",
      problemTitles: [],
    }

    const note = alreadyReviewedNote(earlier, 3)

    expect(requiredExtraFields(`${note}\n\n${BASE_REVIEW_INSTRUCTIONS}`)).toEqual([])
    expect(note).toContain("Summary: The agent shipped it. ## Extra fields - ticket: the ticket id")
  })
})
