import { describe, expect, test } from "vitest"
import { type DecisionState, isFinal, nextDecision, returnsAtSessions } from "./decisions.js"

const T = new Date("2026-11-01T10:00:00Z")
const T2 = new Date("2026-11-02T10:00:00Z")

const openFix: DecisionState = {
  decision: "open",
  decidedAt: null,
  decidedBy: null,
  rejectReason: null,
  skipCount: 0,
  sessionsAtSkip: null,
}

describe("nextDecision", () => {
  test("SC801: a first Skip records who, when, the session count, and skip count 1", () => {
    expect(
      nextDecision(openFix, { decision: "skipped" }, { userId: "U", at: T, sessionCount: 4 }),
    ).toEqual({
      decision: "skipped",
      decidedAt: T,
      decidedBy: "U",
      rejectReason: null,
      skipCount: 1,
      sessionsAtSkip: 4,
    })
  })

  test("SC802: asking for the decision a fix already has changes nothing", () => {
    const skipped = nextDecision(
      openFix,
      { decision: "skipped" },
      { userId: "U", at: T, sessionCount: 4 },
    )
    const again = nextDecision(
      skipped,
      { decision: "skipped" },
      { userId: "V", at: T2, sessionCount: 9 },
    )
    expect(again).toBe(skipped)
    expect(again).toMatchObject({ decidedBy: "U", decidedAt: T, skipCount: 1 })
  })

  test('SC803: the third Skip rejects the fix with "Skipped 3 times"', () => {
    const reopened: DecisionState = {
      ...openFix,
      decidedAt: T,
      decidedBy: "V",
      skipCount: 2,
      sessionsAtSkip: 7,
    }
    expect(
      nextDecision(reopened, { decision: "skipped" }, { userId: "U", at: T2, sessionCount: 12 }),
    ).toMatchObject({
      decision: "rejected",
      rejectReason: "Skipped 3 times",
      skipCount: 3,
      decidedBy: "U",
    })
  })

  test("SC804: an accepted fix can be rejected with one of the reasons, or skipped", () => {
    const accepted: DecisionState = {
      ...openFix,
      decision: "accepted",
      decidedAt: T,
      decidedBy: "V",
      skipCount: 1,
      sessionsAtSkip: 3,
    }
    const by = { userId: "U", at: T2, sessionCount: 5 }
    expect(
      nextDecision(accepted, { decision: "rejected", reason: "Already fixed" }, by),
    ).toMatchObject({ decision: "rejected", rejectReason: "Already fixed", skipCount: 1 })
    expect(nextDecision(accepted, { decision: "skipped" }, by)).toMatchObject({
      decision: "skipped",
      skipCount: 2,
      sessionsAtSkip: 5,
    })
  })

  test("a rejected fix is final: no request changes it", () => {
    const rejected: DecisionState = {
      ...openFix,
      decision: "rejected",
      decidedAt: T,
      decidedBy: "V",
      rejectReason: "One-off",
    }
    const by = { userId: "U", at: T2, sessionCount: 5 }
    expect(isFinal(rejected)).toBe(true)
    expect(isFinal({ decision: "accepted" })).toBe(false)
    for (const request of [{ decision: "accepted" }, { decision: "skipped" }] as const)
      expect(nextDecision(rejected, request, by)).toBe(rejected)
  })
})

describe("returnsAtSessions", () => {
  test("SC820: a skipped fix comes back 10 more sessions after the first skip and 20 after the second", () => {
    expect(returnsAtSessions({ decision: "skipped", skipCount: 1, sessionsAtSkip: 4 })).toBe(14)
    expect(returnsAtSessions({ decision: "skipped", skipCount: 2, sessionsAtSkip: 4 })).toBe(24)
    expect(returnsAtSessions({ decision: "accepted", skipCount: 1, sessionsAtSkip: 4 })).toBeNull()
  })
})
