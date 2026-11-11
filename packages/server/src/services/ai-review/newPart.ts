import {
  messageIdOf,
  type Problem,
  type ProblemReview,
  recordsInReviewOrder,
  type SessionExport,
  type SessionExportRecord,
} from "@samskara/core"

/** How many already-reviewed records a re-review shows before the new ones, for context. */
export const CONTEXT_RECORDS = 20

export type NewPart = {
  /** The context records, then the new ones, numbered as the session's reviews number them. */
  readonly exported: SessionExport
  /** The number of the first new record: every record below it was reviewed before. */
  readonly firstNew: number
  readonly newCount: number
  /** The earlier review's `recordIds` with the new records' message ids after them. */
  readonly recordIds: ReadonlyArray<string | null>
}

/**
 * What a re-review reads. A record is new when its message is not in the earlier review's
 * `recordIds`. Messages sort by lineNumber across tracks and a subagent's lines restart at 1,
 * so a new subagent message can sort among old ones; numbering the new records after every old
 * one is what keeps an old problem's `msg-N` pointing at the same message.
 *
 * A tool call and its result are one record, keyed by the call, so a call reviewed before its
 * result arrived is read again when its result is in `storedSince` (the messages stored after
 * the earlier review). It keeps its old number as well, so saved evidence still resolves.
 */
export const newPartExport = (
  whole: SessionExport,
  reviewed: ReadonlyArray<string | null>,
  storedSince: ReadonlySet<string> = new Set(),
): NewPart => {
  const seen = new Set(reviewed.filter((id): id is string => id !== null))
  const old = recordsInReviewOrder(whole.records, reviewed)
  const isNew = (record: SessionExportRecord): boolean =>
    record.sourceId === undefined ||
    !seen.has(record.sourceId) ||
    (record.resultSourceId !== undefined && storedSince.has(record.resultSourceId))
  const fresh = whole.records.filter(isNew).map((record, index) => ({
    ...record,
    seq: reviewed.length + index,
    id: messageIdOf(reviewed.length + index),
  }))
  const records: SessionExportRecord[] = [...old.slice(-CONTEXT_RECORDS), ...fresh]
  return {
    exported: {
      meta: whole.meta,
      records,
      index: {
        seqs: records.map((record) => record.seq),
        messageIds: records.map((record) => record.id),
        tracks: [...new Set(records.map((record) => record.track))],
      },
    },
    firstNew: reviewed.length,
    newCount: fresh.length,
    recordIds: [...reviewed, ...fresh.map((record) => record.sourceId ?? null)],
  }
}

/**
 * Put before the review's instructions, so the readers and the reviewer both see it: what was
 * reviewed already, the problems it found, and that outcome and summary cover the whole session.
 */
export const alreadyReviewedNote = (
  earlier: {
    readonly outcome: string
    readonly summary: string
    readonly problemTitles: ReadonlyArray<string>
  },
  firstNew: number,
): string =>
  [
    "## Already reviewed",
    "",
    `This session was reviewed before, up to ${messageIdOf(firstNew - 1)}. session.json holds only what came after, from ${messageIdOf(firstNew)}, with the last records before it for context.`,
    "",
    `- Report only problems that show in ${messageIdOf(firstNew)} or later: every problem needs evidence there. A problem with evidence only before it is dropped.`,
    "- These problems were already found in the earlier part. Do not report them again:",
    ...(earlier.problemTitles.length === 0
      ? ["  - (none)"]
      : earlier.problemTitles.map((title) => `  - ${title}`)),
    // One line: a summary is model-written, and a line of it read as a heading would add a
    // section, such as `## Extra fields`, to the instructions.
    `- Outcome and Summary are for the whole session. Before this part the review said: Outcome: ${earlier.outcome}. Summary: ${earlier.summary.replace(/\s+/g, " ").trim()}`,
    "  Write both again so they cover the earlier part and this one.",
  ].join("\n")

const numberOf = (id: string): number => Number(id.replace(/^msg-/, ""))

/** Keeps the problems with evidence in the new records; each one dropped says why. */
export const keepNewPart = (
  problems: ProblemReview["problems"],
  firstNew: number,
): { readonly problems: ReadonlyArray<Problem>; readonly dropped: ReadonlyArray<string> } => {
  const touchesNew = (problem: Problem): boolean =>
    problem.evidence.some((item) => numberOf(item.to) >= firstNew)
  return {
    problems: problems.filter(touchesNew),
    dropped: problems
      .filter((problem) => !touchesNew(problem))
      .map((problem) => `"${problem.title}": evidence only in the already-reviewed part`),
  }
}
