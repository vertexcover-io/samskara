import { type ApiResult, client, request } from "./client.js"
import type { ReviewBatchView } from "./types.js"

/** Starts reviewing these sessions, then finding fixes for their projects. 202 is the start. */
export const startReviewBatch = (
  sessionIds: ReadonlyArray<string>,
): Promise<ApiResult<{ readonly batchId: string; readonly notAllowed: ReadonlyArray<string> }>> =>
  request(() => client.api["review-batches"].$post({ json: { sessionIds: [...sessionIds] } }))

/** The user's latest batch, or null when they have none since the server last started. */
export const fetchCurrentReviewBatch = (): Promise<ApiResult<ReviewBatchView | null>> =>
  request(() => client.api["review-batches"].current.$get()).then((result) =>
    result.ok ? { ok: true, data: result.data.batch } : result,
  )
