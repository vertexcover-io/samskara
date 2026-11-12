/**
 * What a project's editors decided about a fix (a row of `learnings`). `open` until someone
 * decides; `accepted` keeps it in the Open list, marked as a real fix; `skipped` hides it until
 * fix runs see it in enough more sessions; `rejected` hides it, with a reason, and fix runs stop
 * rewriting it.
 */
export const FIX_DECISIONS = ["open", "accepted", "skipped", "rejected"] as const
export type FixDecision = (typeof FIX_DECISIONS)[number]

/** The skip that reaches this count rejects the fix instead, with `SKIPPED_TOO_OFTEN`. */
export const SKIPS_TO_REJECT = 3
export const SKIPPED_TOO_OFTEN = "Skipped 3 times"

/** The longest reason a person may give for rejecting a fix: one short line. */
export const REJECT_REASON_MAX = 200

/** How many more sessions a skipped fix must be seen in to come back: after skip 1, skip 2. */
export const SKIP_RETURNS_AFTER = [10, 20] as const

/** A fix's decision as `learnings` stores it. */
export type DecisionState = {
  readonly decision: FixDecision
  /** When the decision was last set; null on a fix nobody has decided on. */
  readonly decidedAt: Date | null
  /** Who set it; null on a fix nobody decided on, or one that came back on its own. */
  readonly decidedBy: string | null
  /** Set exactly while the decision is `rejected`. */
  readonly rejectReason: string | null
  /** Every skip ever; reopening never resets it. */
  readonly skipCount: number
  /** The fix's session count at its last skip; null if it was never skipped. */
  readonly sessionsAtSkip: number | null
}

/** What a person asks for. Only Reject carries a reason. */
export type DecisionRequest =
  | { readonly decision: "open" | "accepted" | "skipped" }
  | { readonly decision: "rejected"; readonly reason: string }

/**
 * The decision after `by` asks for `request`. Asking for the decision the fix already has
 * returns `current` itself, so a second Skip keeps the first one's person and time. Every Skip
 * adds one to the skip count and records the fix's session count at that moment; the skip that
 * reaches `SKIPS_TO_REJECT` rejects the fix with `SKIPPED_TOO_OFTEN` instead.
 */
export const nextDecision = (
  current: DecisionState,
  request: DecisionRequest,
  by: { readonly userId: string; readonly at: Date; readonly sessionCount: number },
): DecisionState => {
  if (request.decision === current.decision) return current
  const decided = { decidedAt: by.at, decidedBy: by.userId }
  if (request.decision === "skipped") {
    const skipCount = current.skipCount + 1
    const rejects = skipCount >= SKIPS_TO_REJECT
    return {
      ...decided,
      decision: rejects ? "rejected" : "skipped",
      rejectReason: rejects ? SKIPPED_TOO_OFTEN : null,
      skipCount,
      sessionsAtSkip: by.sessionCount,
    }
  }
  return {
    ...decided,
    decision: request.decision,
    rejectReason: request.decision === "rejected" ? request.reason.trim() : null,
    skipCount: current.skipCount,
    sessionsAtSkip: current.sessionsAtSkip,
  }
}

/**
 * The session count at which a skipped fix comes back to open, or null when it is not
 * skipped. The count is the one the Fixes card shows (`sessionCountOf` on the server).
 */
export const returnsAtSessions = (
  fix: Pick<DecisionState, "decision" | "skipCount" | "sessionsAtSkip">,
): number | null => {
  if (fix.decision !== "skipped" || fix.sessionsAtSkip === null) return null
  const after = SKIP_RETURNS_AFTER[fix.skipCount - 1]
  return after === undefined ? null : fix.sessionsAtSkip + after
}
