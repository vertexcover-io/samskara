import { type ApiResult, client, request } from "./client.js"

/** Queues a review for each ticked session; 202 says how many were queued and skipped. */
export const startReviewBatch = (
  sessionIds: ReadonlyArray<string>,
): Promise<
  ApiResult<{
    readonly queued: number
    readonly skipped: number
    readonly notAllowed: ReadonlyArray<string>
  }>
> => request(() => client.api["review-batches"].$post({ json: { sessionIds: [...sessionIds] } }))
