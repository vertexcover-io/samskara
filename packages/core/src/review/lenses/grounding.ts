import type { AiReviewPayload } from "./schema.js"

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
  const problems: GroundingProblem[] = []

  for (const [lensIndex, lens] of payload.lenses.entries()) {
    const lensPath = `lenses[${lensIndex}]`
    if (lens.lens === "timeline") {
      let previous: number | undefined
      for (const [entryIndex, entry] of lens.entries.entries()) {
        const entryPath = `${lensPath}.entries[${entryIndex}]`
        if (!index.seqs.has(entry.fromSeq)) {
          problems.push({
            path: `${entryPath}.fromSeq`,
            problem: `fromSeq ${entry.fromSeq} is not a seq in the session export`,
          })
        }
        if (!index.seqs.has(entry.toSeq)) {
          problems.push({
            path: `${entryPath}.toSeq`,
            problem: `toSeq ${entry.toSeq} is not a seq in the session export`,
          })
        }
        for (const [idIndex, messageId] of entry.messageIds.entries()) {
          if (!index.messageIds.has(messageId)) {
            problems.push({
              path: `${entryPath}.messageIds[${idIndex}]`,
              problem: `messageId "${messageId}" is not in the session export`,
            })
          }
        }
        for (const [trackIndex, track] of entry.tracks.entries()) {
          if (!index.tracks.has(track)) {
            problems.push({
              path: `${entryPath}.tracks[${trackIndex}]`,
              problem: `track "${track}" is not in the session export`,
            })
          }
        }
        if (previous !== undefined && entry.fromSeq <= previous) {
          problems.push({
            path: `${entryPath}.fromSeq`,
            problem: `fromSeq must be strictly ascending (previous entry starts at ${previous})`,
          })
        }
        previous = entry.fromSeq
      }
      continue
    }
    for (const [learningIndex, learning] of lens.learnings.entries()) {
      for (const [evidenceIndex, evidence] of learning.evidence.entries()) {
        const evidencePath = `${lensPath}.learnings[${learningIndex}].evidence[${evidenceIndex}]`
        if (!index.seqs.has(evidence.seq)) {
          problems.push({
            path: `${evidencePath}.seq`,
            problem: `seq ${evidence.seq} is not a seq in the session export`,
          })
        }
        if (!index.messageIds.has(evidence.messageId)) {
          problems.push({
            path: `${evidencePath}.messageId`,
            problem: `messageId "${evidence.messageId}" is not in the session export`,
          })
        }
      }
    }
  }

  return problems.length === 0 ? { ok: true } : { ok: false, problems }
}
