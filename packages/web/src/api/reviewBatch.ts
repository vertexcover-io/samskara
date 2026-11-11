import { type ApiResult, client, request } from "./client.js"

/**
 * Queues a review for each ticked session, and a fix run for each project that got one; 202
 * says how many were queued and skipped.
 */
export const startReviewBatch = (
  sessionIds: ReadonlyArray<string>,
): Promise<
  ApiResult<{
    readonly queued: number
    readonly skipped: number
    readonly notAllowed: ReadonlyArray<string>
    /** Projects whose fix run is queued to start once their reviews finish. */
    readonly fixRunsQueued: number
  }>
> => request(() => client.api["review-batches"].$post({ json: { sessionIds: [...sessionIds] } }))
