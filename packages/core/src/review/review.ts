import { heuristicSessionAnalyzer } from "./analyzer.js"
import { extractLearnings } from "./extractor.js"
import type { ReviewInput, SessionReview } from "./types.js"

/**
 * The full review pipeline: signals first, then learning extraction grounded in the same
 * event stream. Composed here rather than inside the analyzer so a future LLM analyzer can
 * reuse the extractor unchanged — it only needs to produce `SessionReview` signals.
 */
export const runReview = (input: ReviewInput): SessionReview => {
  const review = heuristicSessionAnalyzer.analyze(input)
  const { agent, human } = extractLearnings(review.signals, input.events)
  return { ...review, agentLearnings: agent, humanFeedback: human }
}
