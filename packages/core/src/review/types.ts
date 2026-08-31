import type { ReviewEvent, ReviewFriction, ReviewOutcome } from "./events.js"

/** One run of the same tool failing back-to-back — the strongest structural pain signal. */
export type ErrorLoop = {
  readonly toolName: string
  readonly consecutiveFailures: number
  readonly firstSeq: number
  readonly lastSeq: number
}

/** How many times one path was edited — churn on the same file is rework, not progress. */
export type EditChurn = {
  readonly path: string
  readonly editCount: number
}

export type ReviewSignals = {
  readonly turns: number
  readonly abortedTurns: number
  readonly userPrompts: number
  readonly toolCalls: number
  readonly toolFailures: number
  readonly toolFailureRate: number
  readonly errorLoops: ReadonlyArray<ErrorLoop>
  readonly edits: ReadonlyArray<EditChurn>
  readonly compactions: number
  readonly userPromptsAfterFailures: number
  readonly rapidReprompts: number
  readonly commits: number
  readonly pullRequests: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cachedTokens: number
  readonly thinkingTokens: number
}

/** Points at the event-stream position that proves a claim. */
export type EvidenceRef = {
  readonly seq: number
  readonly what: string
}

export const LEARNING_CATEGORIES = [
  "tool-retry",
  "task-shape",
  "supervision",
  "prompt-shape",
  "context-hygiene",
  "rework",
] as const

export type LearningCategory = (typeof LEARNING_CATEGORIES)[number]

export type LearningCandidate = {
  readonly audience: "agent" | "human"
  readonly category: LearningCategory
  readonly title: string
  readonly detail: string
  readonly evidence: ReadonlyArray<EvidenceRef>
  readonly fingerprint: string
}

export type SessionReview = {
  readonly sessionId: string
  readonly analyzer: string
  readonly analyzedAt: string
  readonly outcome: ReviewOutcome
  readonly friction: ReviewFriction
  readonly summary: string
  readonly signals: ReviewSignals
  readonly agentLearnings: ReadonlyArray<LearningCandidate>
  readonly humanFeedback: ReadonlyArray<LearningCandidate>
}

export type ReviewInput = {
  readonly sessionId: string
  readonly events: ReadonlyArray<ReviewEvent>
  readonly now?: () => Date
}

export type SessionAnalyzer = {
  readonly name: string
  analyze(input: ReviewInput): SessionReview
}
