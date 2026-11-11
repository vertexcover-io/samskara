import type { ApiError } from "../api/client.js"

/** The most sessions one press of Review takes; the server answers 400 past it. */
export const MAX_BATCH_SESSIONS = 50

/** Adds or removes one id; adding past MAX_BATCH_SESSIONS does nothing. */
export const toggled = (selected: ReadonlySet<string>, id: string): ReadonlySet<string> => {
  if (selected.has(id)) return new Set([...selected].filter((each) => each !== id))
  return selected.size >= MAX_BATCH_SESSIONS ? selected : new Set([...selected, id])
}

/** Adds or removes these ids and keeps every other pick, never past the cap. */
export const withPage = (
  selected: ReadonlySet<string>,
  pageIds: ReadonlyArray<string>,
  on: boolean,
): ReadonlySet<string> =>
  on
    ? new Set(
        [...selected, ...pageIds.filter((id) => !selected.has(id))].slice(0, MAX_BATCH_SESSIONS),
      )
    : new Set([...selected].filter((id) => !pageIds.includes(id)))

/** Why the server would not start a batch, in plain words. */
const REFUSED: Readonly<Record<string, string>> = {
  tooManySessions: `Pick ${MAX_BATCH_SESSIONS} sessions or fewer.`,
  harnessUnauthenticated: "The reviewer has no key on this server.",
}

export const refusalMessage = (error: ApiError): string =>
  (error.code === null ? undefined : REFUSED[error.code]) ?? error.message

const sessions = (count: number): string => `${count} session${count === 1 ? "" : "s"}`

/** What pressing Review did, in one line: queued, already reviewed, not yours to review. */
export const queuedMessage = (counts: {
  readonly queued: number
  readonly skipped: number
  readonly notAllowed: ReadonlyArray<string>
}): string =>
  [
    `Queued ${sessions(counts.queued)} for review.`,
    counts.skipped === 0 ? null : `${sessions(counts.skipped)} already had a review.`,
    counts.notAllowed.length === 0
      ? null
      : `${sessions(counts.notAllowed.length)} you cannot edit.`,
  ]
    .filter((part) => part !== null)
    .join(" ")
