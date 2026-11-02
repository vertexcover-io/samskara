import { useCallback, useEffect, useState } from "react"
import type { ApiError } from "../api/client.js"
import { fetchCurrentReviewBatch, startReviewBatch } from "../api/reviewBatch.js"
import type { ReviewBatchView } from "../api/types.js"

/** How often a running batch is checked. Reviews take minutes; 3 seconds is plenty. */
export const BATCH_POLL_MS = 3_000

export const useReviewBatch = () => {
  const [batch, setBatch] = useState<ReviewBatchView | null>(null)
  const [error, setError] = useState<ApiError | null>(null)
  /** Set once a check answers 401; checking stops, since every later one would too. */
  const [expired, setExpired] = useState(false)

  const refresh = useCallback(async (): Promise<void> => {
    const result = await fetchCurrentReviewBatch()
    if (result.ok) setBatch(result.data)
    else if (result.error.kind === "unauthorized") setExpired(true)
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const running = batch?.status === "running"
  useEffect(() => {
    if (!running || expired) return
    const timer = setInterval(() => void refresh(), BATCH_POLL_MS)
    return () => clearInterval(timer)
  }, [running, expired, refresh])

  /** True when the server took the batch; the error is kept for the page to show otherwise. */
  const start = useCallback(
    async (sessionIds: ReadonlyArray<string>): Promise<boolean> => {
      setError(null)
      const result = await startReviewBatch(sessionIds)
      if (!result.ok) {
        setError(result.error)
        return false
      }
      await refresh()
      return true
    },
    [refresh],
  )

  return { batch, error, expired, start }
}
