import { messageIdOf } from "./export.js"
import { type AiReviewLens, type AiReviewPayload, ascendingMessage } from "./schema.js"

/** The part of a session export grounding checks run against — sets, because lookups are all it does. */
export type SessionIndex = {
  readonly seqs: ReadonlySet<number>
  readonly messageIds: ReadonlySet<string>
  readonly tracks: ReadonlySet<string>
}

export type GroundingProblem = {
  readonly path: string
  readonly problem: string
}

export type GroundingResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly problems: ReadonlyArray<GroundingProblem> }

/** Adapts the array-shaped index `buildSessionExport` produces into the sets grounding wants. */
export const sessionIndexFrom = (index: {
  seqs: ReadonlyArray<number>
  messageIds: ReadonlyArray<string>
  tracks: ReadonlyArray<string>
}): SessionIndex => ({
  seqs: new Set(index.seqs),
  messageIds: new Set(index.messageIds),
  tracks: new Set(index.tracks),
})

/** One problem, or none — the whole shape of every grounding check in this file. */
const missing = (found: boolean, path: string, problem: string): GroundingProblem[] =>
  found ? [] : [{ path, problem }]

const timelineProblems = (
  lens: Extract<AiReviewLens, { lens: "timeline" }>,
  lensPath: string,
  index: SessionIndex,
): GroundingProblem[] =>
  lens.entries.flatMap((entry, entryIndex, entries) => {
    const path = `${lensPath}.entries[${entryIndex}]`
    const previous = entries[entryIndex - 1]?.fromSeq
    return [
      ...missing(
        index.seqs.has(entry.fromSeq),
        `${path}.fromSeq`,
        `fromSeq ${entry.fromSeq} is not a seq in the session export`,
      ),
      ...missing(
        index.seqs.has(entry.toSeq),
        `${path}.toSeq`,
        `toSeq ${entry.toSeq} is not a seq in the session export`,
      ),
      ...entry.messageIds.flatMap((messageId, idIndex) =>
        missing(
          index.messageIds.has(messageId),
          `${path}.messageIds[${idIndex}]`,
          `messageId "${messageId}" is not in the session export`,
        ),
      ),
      ...entry.tracks.flatMap((track, trackIndex) =>
        missing(
          index.tracks.has(track),
          `${path}.tracks[${trackIndex}]`,
          `track "${track}" is not in the session export`,
        ),
      ),
      ...(previous === undefined
        ? []
        : missing(entry.fromSeq > previous, `${path}.fromSeq`, ascendingMessage(previous))),
    ]
  })

const learningProblems = (
  lens: Exclude<AiReviewLens, { lens: "timeline" }>,
  lensPath: string,
  index: SessionIndex,
): GroundingProblem[] =>
  lens.learnings.flatMap((learning, learningIndex) =>
    learning.evidence.flatMap((evidence, evidenceIndex) => {
      const path = `${lensPath}.learnings[${learningIndex}].evidence[${evidenceIndex}]`
      return [
        ...missing(
          index.seqs.has(evidence.seq),
          `${path}.seq`,
          `seq ${evidence.seq} is not a seq in the session export`,
        ),
        ...missing(
          index.messageIds.has(evidence.messageId),
          `${path}.messageId`,
          `messageId "${evidence.messageId}" is not in the session export`,
        ),
        // Both halves existing is not enough. The export mints `msg-<seq>`, so a ref whose
        // halves name different records still passes two membership tests while pointing at
        // two unrelated messages — the evidence text describes one, the permalink scrolls to
        // the other. Only checked once both halves resolve, so a dangling half is reported
        // as itself rather than twice.
        ...missing(
          !index.seqs.has(evidence.seq) ||
            !index.messageIds.has(evidence.messageId) ||
            evidence.messageId === messageIdOf(evidence.seq),
          `${path}.messageId`,
          `messageId "${evidence.messageId}" does not belong to seq ${evidence.seq}`,
        ),
      ]
    }),
  )

/**
 * The audit gate between an AI review and the database: every seq, messageId and track the
 * payload cites must exist in the session export, and the timeline must read in strictly
 * ascending order. Shape was already settled by `aiReviewPayloadSchema`; this checks the
 * payload against reality. Learnings and breadcrumbs are audited the same way: refs that
 * cite the transcript must resolve — no lens gets a free pass. Paths mirror the JSON
 * structure (`lenses[0].entries[2].messageIds[1]`) so a rejected run can be traced to the
 * exact claim that dangled.
 */
export const validateGrounding = (
  payload: AiReviewPayload,
  index: SessionIndex,
): GroundingResult => {
  const problems = payload.lenses.flatMap((lens, lensIndex) => {
    const lensPath = `lenses[${lensIndex}]`
    return lens.lens === "timeline"
      ? timelineProblems(lens, lensPath, index)
      : learningProblems(lens, lensPath, index)
  })
  return problems.length === 0 ? { ok: true } : { ok: false, problems }
}
