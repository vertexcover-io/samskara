import { type ApiResult, client, request } from "./client.js"

/** One mode for the whole batch: new messages (a full review when never reviewed) or full. */
export type BatchReviewMode = "full" | "newMessages"

/**
 * Queues a review for each ticked session in `mode`, and a fix run for each project that got
 * one; 202 says how many were queued and skipped.
 */
export const startReviewBatch = (
  sessionIds: ReadonlyArray<string>,
  mode: BatchReviewMode,
): Promise<
  ApiResult<{
    readonly queued: number
    readonly skipped: number
    readonly notAllowed: ReadonlyArray<string>
    /** Projects whose fix run is queued to start once their reviews finish. */
    readonly fixRunsQueued: number
  }>
> =>
  request(() => client.api["review-batches"].$post({ json: { sessionIds: [...sessionIds], mode } }))
