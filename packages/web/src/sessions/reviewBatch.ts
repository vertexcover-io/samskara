import type { ApiError } from "../api/client.js"

/** The most sessions one batch takes; the server answers 400 past it. */
export const MAX_BATCH_SESSIONS = 50
/** About how long one review takes. */
export const MINUTES_PER_REVIEW = 3
/** How many reviews the server runs at once for one batch. */
export const REVIEW_LANES = 3
/** About how long finding fixes takes once the reviews are in. */
export const MINUTES_TO_FIND_FIXES = 5

/** The bar's "about X min": the reviews spread over the lanes, then finding fixes. */
export const estimateMinutes = (count: number): number =>
  count === 0 ? 0 : Math.ceil((count * MINUTES_PER_REVIEW) / REVIEW_LANES) + MINUTES_TO_FIND_FIXES

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
  reviewBatchAlreadyRunning: "A review is already running. Wait for it to finish.",
  tooManySessions: `Pick ${MAX_BATCH_SESSIONS} sessions or fewer.`,
  harnessUnauthenticated: "The reviewer has no key on this server.",
}

export const refusalMessage = (error: ApiError): string =>
  (error.code === null ? undefined : REFUSED[error.code]) ?? error.message
