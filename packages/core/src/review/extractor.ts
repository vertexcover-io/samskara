import { createHash } from "node:crypto"
import type { LearningAudience, ReviewEvent } from "./events.js"
import type { EvidenceRef, LearningCandidate, LearningCategory, ReviewSignals } from "./types.js"

/** Edits to one path at or above this count are rework worth reporting. */
export const REWORK_EDIT_THRESHOLD = 3

/** Rapid re-prompts at or above this count are a prompt-shape lesson. */
export const RAPID_REPROMPT_THRESHOLD = 2

/** Aborted turns at or above this count are a task-shape lesson. */
export const ABORTED_TURN_THRESHOLD = 2

/** Compactions at or above this count are a context-hygiene lesson. */
export const COMPACTION_THRESHOLD = 2

/** Evidence refs are capped per learning so a persisted row stays readable. */
const MAX_EVIDENCE = 5

/**
 * The fingerprint deliberately excludes counts: "Bash failed 3 times" and "Bash failed 9
 * times" are the same lesson seen twice, and the server accumulates occurrences instead of
 * storing near-duplicates. The subject (tool, path) stays in, so different subjects stay
 * different lessons.
 */
export const fingerprintOf = (
  audience: LearningAudience,
  category: LearningCategory,
  subject: string,
): string =>
  createHash("sha256").update(`${audience}:${category}:${subject}`).digest("hex").slice(0, 16)

const seqsWhere = (events: ReadonlyArray<ReviewEvent>, pred: (event: ReviewEvent) => boolean) =>
  events.filter(pred).map((event) => event.seq)

const evidenceFrom = (
  seqs: ReadonlyArray<number>,
  what: (index: number) => string,
): EvidenceRef[] => {
  if (seqs.length === 0) return []
  const lastIndex = seqs.length - 1
  // First few plus the last: for a long run, the middle proves nothing the ends do not.
  const picks =
    seqs.length <= MAX_EVIDENCE
      ? seqs.map((_, index) => index)
      : [...Array.from({ length: MAX_EVIDENCE - 1 }, (_, index) => index), lastIndex]
  return picks.flatMap((index) => {
    const seq = seqs[index]
    return seq === undefined ? [] : [{ seq, what: what(index) }]
  })
}

const failureSeqsForLoop = (
  events: ReadonlyArray<ReviewEvent>,
  loop: ReviewSignals["errorLoops"][number],
) =>
  seqsWhere(
    events,
    (event) =>
      event.kind === "toolResult" &&
      event.status === "failure" &&
      event.seq >= loop.firstSeq &&
      event.seq <= loop.lastSeq,
  )

/**
 * Turns structural signals into learning candidates, both audiences at once. Every rule is
 * grounded: the candidate carries the event positions that triggered it, so a human reader
 * can open the transcript at the exact spot and check the claim.
 */
export const extractLearnings = (
  signals: ReviewSignals,
  events: ReadonlyArray<ReviewEvent>,
): { agent: LearningCandidate[]; human: LearningCandidate[] } => {
  const agent: LearningCandidate[] = []
  const human: LearningCandidate[] = []

  for (const loop of signals.errorLoops) {
    agent.push({
      audience: "agent",
      category: "tool-retry",
      title: `${loop.toolName} failed ${loop.consecutiveFailures} times in a row`,
      detail:
        `${loop.consecutiveFailures} consecutive failures of ${loop.toolName} in this session. ` +
        "After the second failure of the same call shape, change the approach instead of retrying it.",
      evidence: evidenceFrom(
        failureSeqsForLoop(events, loop),
        (index) => `failure ${index + 1} of ${loop.toolName}`,
      ),
      fingerprint: fingerprintOf("agent", "tool-retry", loop.toolName),
    })
  }

  for (const churn of signals.edits) {
    if (churn.editCount < REWORK_EDIT_THRESHOLD) continue
    const seqs = seqsWhere(events, (event) => event.kind === "edit" && event.path === churn.path)
    agent.push({
      audience: "agent",
      category: "rework",
      title: `${churn.path} was edited ${churn.editCount} times in one session`,
      detail:
        `${churn.editCount} edits landed on ${churn.path} before the session ended. ` +
        "Repeated edits to one path usually mean the plan for it changed mid-flight — settle the shape first, then write.",
      evidence: evidenceFrom(seqs, (index) => `edit ${index + 1} of ${churn.path}`),
      fingerprint: fingerprintOf("agent", "rework", churn.path),
    })
  }

  if (signals.userPromptsAfterFailures >= 1) {
    // Re-derive the prompt positions: a prompt qualifies when at least two failures landed
    // since the previous prompt, mirroring the analyzer's counter.
    let failuresSincePrompt = 0
    const seqs: number[] = []
    for (const event of events) {
      if (event.kind === "userMessage" && !event.isMeta) {
        if (failuresSincePrompt >= 2) seqs.push(event.seq)
        failuresSincePrompt = 0
      } else if (event.kind === "toolResult" && event.status === "failure") {
        failuresSincePrompt += 1
      }
    }
    human.push({
      audience: "human",
      category: "supervision",
      title: `${signals.userPromptsAfterFailures} prompt${signals.userPromptsAfterFailures === 1 ? "" : "s"} arrived while errors were piling up`,
      detail:
        `${signals.userPromptsAfterFailures} of your prompts came right after tool failures. ` +
        "Stating in the first prompt what to do when a command fails — stop, ask, or change approach — " +
        "lets the agent correct course without waiting for you.",
      evidence: evidenceFrom(seqs, () => "prompt sent after repeated failures"),
      fingerprint: fingerprintOf("human", "supervision", "supervision"),
    })
  }

  if (signals.rapidReprompts >= RAPID_REPROMPT_THRESHOLD) {
    let eventsSincePrompt = 0
    let prompts = 0
    const seqs: number[] = []
    for (const event of events) {
      if (event.kind === "userMessage" && !event.isMeta) {
        if (prompts > 0 && eventsSincePrompt === 0) seqs.push(event.seq)
        prompts += 1
        eventsSincePrompt = 0
      } else {
        eventsSincePrompt += 1
      }
    }
    human.push({
      audience: "human",
      category: "prompt-shape",
      title: `${signals.rapidReprompts} prompts were re-issued with no work in between`,
      detail:
        `${signals.rapidReprompts} of your prompts arrived before the agent did anything with the previous one. ` +
        "One prompt with the full intent usually beats several quick corrections — the agent pays for each restart.",
      evidence: evidenceFrom(seqs, () => "re-prompt with no intervening work"),
      fingerprint: fingerprintOf("human", "prompt-shape", "prompt-shape"),
    })
  }

  if (signals.abortedTurns >= ABORTED_TURN_THRESHOLD) {
    const seqs = seqsWhere(events, (event) => event.kind === "turn" && event.status === "aborted")
    human.push({
      audience: "human",
      category: "task-shape",
      title: `${signals.abortedTurns} turns were aborted`,
      detail:
        `${signals.abortedTurns} turns were stopped before finishing. Turns that get aborted are usually ` +
        "too large or too vague to converge — splitting the ask keeps each turn landable.",
      evidence: evidenceFrom(seqs, () => "aborted turn"),
      fingerprint: fingerprintOf("human", "task-shape", "task-shape"),
    })
  }

  if (signals.compactions >= COMPACTION_THRESHOLD) {
    const seqs = seqsWhere(events, (event) => event.kind === "compaction")
    agent.push({
      audience: "agent",
      category: "context-hygiene",
      title: `Context was compacted ${signals.compactions} times`,
      detail:
        `${signals.compactions} compactions in one session mean the context outgrew the work. ` +
        "Close the session at a natural boundary and start the next phase fresh rather than compacting through it.",
      evidence: evidenceFrom(seqs, (index) => `compaction ${index + 1}`),
      fingerprint: fingerprintOf("agent", "context-hygiene", "context-hygiene"),
    })
  }

  return { agent, human }
}
