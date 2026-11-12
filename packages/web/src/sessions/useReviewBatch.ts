import { useCallback, useState } from "react"
import type { ApiError } from "../api/client.js"
import { type BatchReviewMode, startReviewBatch } from "../api/reviewBatch.js"
import { queuedMessage } from "./reviewBatch.js"

export const useReviewBatch = () => {
  const [error, setError] = useState<ApiError | null>(null)
  const [note, setNote] = useState<string | null>(null)

  /** True when the server queued the reviews; the error is kept for the page to show otherwise. */
  const start = useCallback(
    async (sessionIds: ReadonlyArray<string>, mode: BatchReviewMode): Promise<boolean> => {
      setError(null)
      setNote(null)
      const result = await startReviewBatch(sessionIds, mode)
      if (!result.ok) {
        setError(result.error)
        return false
      }
      setNote(queuedMessage(result.data))
      return true
    },
    [],
  )

  return { error, note, start }
}
