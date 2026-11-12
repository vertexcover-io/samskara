import { z } from "zod"
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

/**
 * One time the problem happened, told as 3 or 4 short steps that end where it turned out
 * wrong, then why that is a problem and what should have happened. Every quote is the
 * session's own words, checked against the group's evidence before it is saved.
 */
export const learningStorySchema = z
  .object({
    steps: z
      .array(z.object({ text: z.string().min(1), quote: z.string().min(1) }).strict())
      .min(3)
      .max(4),
    whyProblem: z.string().min(1),
    shouldHave: z.string().min(1),
  })
  .strict()

export type LearningStory = z.infer<typeof learningStorySchema>

/** A stored story, or null when there is none or it no longer fits the shape. */
export const parseStory = (value: unknown): LearningStory | null => {
  const parsed = learningStorySchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

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
  /** The fix in one plain sentence, before its exact text. Null on an older learning. */
  readonly fixSummary: string | null
  /** The example the fix's page opens on. Null on a learning written before it was asked for. */
  readonly story: LearningStory | null
}

/** What the grouper is shown of a learning so far. A rejected one carries why. */
export type KnownLearning = Pick<LearningInput, "id" | "title" | "cause"> & {
  /** Why the project rejected it; null or absent when it is not rejected. */
  readonly rejectedReason?: string | null
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
      "id" | "cause" | "impact" | "impactReason" | "howItHelps" | "fixSummary" | "story"
    > & {
        readonly impact: LearningImpact
        readonly impactReason: string
        readonly howItHelps: string
        readonly fixSummary: string
        /** Null when the group showed no session records to quote. */
        readonly story: LearningStory | null
      })
  | {
      /** Not worth a learning: a one-off, or its excerpts did not clearly show it matters. */
      readonly verdict: "drop"
      readonly reason: string
    }
