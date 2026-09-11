import type { ReviewEvent, ReviewFriction, ReviewOutcome } from "./events.js"
import type {
  ErrorLoop,
  ReviewInput,
  ReviewSignals,
  SessionAnalyzer,
  SessionReview,
} from "./types.js"

export const HEURISTIC_ANALYZER_NAME = "heuristic-v1"

/** Consecutive same-tool failures at or above this count are an error loop. */
const ERROR_LOOP_THRESHOLD = 3

/** Failures since the last real user prompt at or above this count make the next prompt a correction. */
const FAILURES_BEFORE_CORRECTION = 2

const round3 = (value: number): number => Math.round(value * 1000) / 1000

type Accumulator = {
  turns: number
  abortedTurns: number
  userPrompts: number
  toolCalls: number
  toolFailures: number
  compactions: number
  userPromptsAfterFailures: number
  rapidReprompts: number
  commits: number
  pullRequests: number
  inputTokens: number
  outputTokens: number
  cachedTokens: number
  thinkingTokens: number
  editsByPath: Map<string, number>
  currentRun: { toolName: string; failures: number; firstSeq: number; lastSeq: number } | null
  errorLoops: ErrorLoop[]
  failuresSincePrompt: number
  eventsSincePrompt: number
  toolNameByCallId: Map<string, string>
}

const freshAccumulator = (): Accumulator => ({
  turns: 0,
  abortedTurns: 0,
  userPrompts: 0,
  toolCalls: 0,
  toolFailures: 0,
  compactions: 0,
  userPromptsAfterFailures: 0,
  rapidReprompts: 0,
  commits: 0,
  pullRequests: 0,
  inputTokens: 0,
  outputTokens: 0,
  cachedTokens: 0,
  thinkingTokens: 0,
  editsByPath: new Map(),
  currentRun: null,
  errorLoops: [],
  failuresSincePrompt: 0,
  eventsSincePrompt: 0,
  toolNameByCallId: new Map(),
})

const closeRun = (acc: Accumulator): void => {
  if (acc.currentRun !== null && acc.currentRun.failures >= ERROR_LOOP_THRESHOLD) {
    acc.errorLoops.push({
      toolName: acc.currentRun.toolName,
      consecutiveFailures: acc.currentRun.failures,
      firstSeq: acc.currentRun.firstSeq,
      lastSeq: acc.currentRun.lastSeq,
    })
  }
  acc.currentRun = null
}

const countEvents = (acc: Accumulator, event: ReviewEvent): void => {
  if (event.kind === "userMessage") {
    if (event.isMeta) return
    // A prompt that arrives while failures are still piling up is the human putting a hand in.
    if (acc.failuresSincePrompt >= FAILURES_BEFORE_CORRECTION) acc.userPromptsAfterFailures += 1
    // A prompt with no intervening work is a re-prompt: the previous prompt did not stick.
    if (acc.userPrompts > 0 && acc.eventsSincePrompt === 0) acc.rapidReprompts += 1
    acc.userPrompts += 1
    acc.failuresSincePrompt = 0
    acc.eventsSincePrompt = 0
    return
  }
  acc.eventsSincePrompt += 1
  switch (event.kind) {
    case "turn":
      acc.turns += 1
      if (event.status === "aborted") acc.abortedTurns += 1
      break
    case "toolCall":
      acc.toolCalls += 1
      acc.toolNameByCallId.set(event.callId, event.name)
      break
    case "toolResult":
      if (event.status === "failure") {
        acc.toolFailures += 1
        acc.failuresSincePrompt += 1
        // Results can arrive without a name (the transcript puts it only on the call side);
        // the call seen earlier in the same stream fills it in.
        const name = event.name ?? acc.toolNameByCallId.get(event.callId) ?? "unknown tool"
        if (acc.currentRun === null || acc.currentRun.toolName !== name) {
          closeRun(acc)
          acc.currentRun = { toolName: name, failures: 1, firstSeq: event.seq, lastSeq: event.seq }
        } else {
          acc.currentRun.failures += 1
          acc.currentRun.lastSeq = event.seq
        }
      } else {
        closeRun(acc)
      }
      break
    case "edit":
      acc.editsByPath.set(event.path, (acc.editsByPath.get(event.path) ?? 0) + 1)
      break
    case "compaction":
      acc.compactions += 1
      break
    case "commit":
      acc.commits += 1
      break
    case "pullRequest":
      acc.pullRequests += 1
      break
    case "tokens":
      acc.inputTokens += event.input
      acc.outputTokens += event.output
      acc.cachedTokens += event.cached
      acc.thinkingTokens += event.thinking
      break
  }
}

const frictionOf = (signals: ReviewSignals): ReviewFriction => {
  if (
    signals.errorLoops.length > 0 ||
    signals.toolFailureRate > 0.25 ||
    signals.userPromptsAfterFailures >= 2
  ) {
    return "high"
  }
  if (signals.toolFailureRate > 0.1 || signals.abortedTurns > 0) return "moderate"
  return "none"
}

/**
 * Outcome answers one question only — did the work land? — because friction carries the pain
 * separately. Precedence: an aborted final turn with nothing committed means the human pulled
 * the plug; then landing evidence (commit or PR) ships regardless of how painful the road
 * was — "shipped with high friction" stays visible because both fields are reported side by
 * side; then high friction without landing is struggled; everything else is productive.
 */
const outcomeOf = (
  events: ReadonlyArray<ReviewEvent>,
  signals: ReviewSignals,
  _friction: ReviewFriction,
): ReviewOutcome => {
  const lastTurn = [...events].reverse().find((event) => event.kind === "turn")
  if (lastTurn !== undefined && lastTurn.status === "aborted" && signals.commits === 0) {
    return "aborted"
  }
  if (signals.commits > 0 || signals.pullRequests > 0) return "shipped"
  if (_friction === "high") return "struggled"
  return "productive"
}

const summarize = (signals: ReviewSignals, outcome: ReviewOutcome, friction: ReviewFriction) =>
  `${outcome}: ${signals.turns} turn${signals.turns === 1 ? "" : "s"}, ` +
  `${signals.toolCalls} tool call${signals.toolCalls === 1 ? "" : "s"}, ` +
  `${signals.toolFailures} failure${signals.toolFailures === 1 ? "" : "s"}, ` +
  `${friction === "none" ? "no friction" : `${friction} friction`}, ` +
  `${signals.commits} commit${signals.commits === 1 ? "" : "s"}`

/**
 * Deterministic, no-LLM analyzer. It reads transcript *structure* — turn boundaries, tool
 * results, edit and prompt timing — and never prose, so the same session always reviews the
 * same way and the tests below are the specification.
 */
export const heuristicSessionAnalyzer: SessionAnalyzer = {
  name: HEURISTIC_ANALYZER_NAME,
  analyze({ sessionId, events, now }: ReviewInput): SessionReview {
    const acc = freshAccumulator()
    for (const event of events) countEvents(acc, event)
    closeRun(acc)

    const sortedPaths = [...acc.editsByPath.entries()].sort((a, b) => b[1] - a[1])
    const signals: ReviewSignals = {
      turns: acc.turns,
      abortedTurns: acc.abortedTurns,
      userPrompts: acc.userPrompts,
      toolCalls: acc.toolCalls,
      toolFailures: acc.toolFailures,
      toolFailureRate: acc.toolCalls === 0 ? 0 : round3(acc.toolFailures / acc.toolCalls),
      errorLoops: acc.errorLoops,
      edits: sortedPaths.map(([path, editCount]) => ({ path, editCount })),
      compactions: acc.compactions,
      userPromptsAfterFailures: acc.userPromptsAfterFailures,
      rapidReprompts: acc.rapidReprompts,
      commits: acc.commits,
      pullRequests: acc.pullRequests,
      inputTokens: acc.inputTokens,
      outputTokens: acc.outputTokens,
      cachedTokens: acc.cachedTokens,
      thinkingTokens: acc.thinkingTokens,
    }

    const friction = frictionOf(signals)
    const outcome = outcomeOf(events, signals, friction)

    return {
      sessionId,
      analyzer: HEURISTIC_ANALYZER_NAME,
      analyzedAt: (now ?? (() => new Date()))().toISOString(),
      outcome,
      friction,
      summary: summarize(signals, outcome, friction),
      signals,
      agentLearnings: [],
      humanFeedback: [],
    }
  },
}
