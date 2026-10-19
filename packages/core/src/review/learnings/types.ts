import type { FixType, Problem } from "../problems/reviewMd.js"

export const LEARNING_PRIORITIES = ["high", "medium", "low"] as const
export type LearningPriority = (typeof LEARNING_PRIORITIES)[number]

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
  | ({ readonly verdict: "learning" } & Omit<LearningInput, "id" | "cause">)
  | {
      /** Not worth a learning: a one-off, or its excerpts did not clearly show it matters. */
      readonly verdict: "drop"
      readonly reason: string
    }
