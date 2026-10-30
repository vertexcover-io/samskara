import type { FixType, Problem } from "../problems/reviewMd.js"

export const LEARNING_PRIORITIES = ["high", "medium", "low"] as const
export type LearningPriority = (typeof LEARNING_PRIORITIES)[number]

/**
 * How bad it is when the problem happens, worst first: the output can be wrong or untested
 * work ships; a person had to notice and correct it; the agent got there but wasted time or
 * tokens. Priority weighs it: at the same frequency, wrong_result ranks above time_only.
 */
export const LEARNING_IMPACTS = ["wrong_result", "person_stepped_in", "time_only"] as const
export type LearningImpact = (typeof LEARNING_IMPACTS)[number]

/** A saved problem, as the learning run reads it: the review's fields, plus where it came from. */
export type ProblemInput = Omit<Problem, "extra"> & {
  readonly id: string
  readonly sessionId: string
  /** The review it came from; its saved record order is how an excerpt finds msg-N. */
  readonly reviewId?: string
  /**
   * Its evidence with the session around it (`problemExcerpt`). Only a batch's new problems
   * carry one, and only agent 2 reads it: it is what a drop is judged on.
   */
  readonly excerpt?: string
}

/** A learning already saved: one cause, and what to change about it. */
export type LearningInput = {
  readonly id: string
  readonly title: string
  readonly cause: string
  readonly problem: string
  readonly priority: LearningPriority
  readonly priorityReason: string
  readonly fixType: FixType
  readonly fix: string
  /** Null on a learning written before impact was asked for. */
  readonly impact: LearningImpact | null
  readonly impactReason: string | null
  /** What changes once the fix is in. Null on a learning written before it was asked for. */
  readonly howItHelps: string | null
}

/** One group from agent 1: problems with the same cause, and the learning they join, if any. */
export type ProblemGroup = {
  readonly cause: string
  /** The existing learning these problems join, or null for a new one. */
  readonly learningId: string | null
  readonly problemIds: ReadonlyArray<string>
}

/** Agent 2's answer for one group. */
export type WrittenLearning =
  | ({ readonly verdict: "learning" } & Omit<
      LearningInput,
      "id" | "cause" | "impact" | "impactReason" | "howItHelps"
    > & {
        readonly impact: LearningImpact
        readonly impactReason: string
        readonly howItHelps: string
      })
  | {
      /** Not worth a learning: a one-off, or its excerpts did not clearly show it matters. */
      readonly verdict: "drop"
      readonly reason: string
    }
