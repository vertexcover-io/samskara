import { useId, useState } from "react"
import type { BatchReviewMode } from "../api/reviewBatch.js"
import { MAX_BATCH_SESSIONS } from "../sessions/reviewBatch.js"

type Props = {
  readonly count: number
  /** A start request is in flight. */
  readonly starting: boolean
  readonly onStart: (mode: BatchReviewMode) => void
  readonly onClear: () => void
}

export const ReviewBar = ({ count, starting, onStart, onClear }: Props) => {
  const [mode, setMode] = useState<BatchReviewMode>("newMessages")
  const modeId = useId()
  return (
    <section
      aria-label="Selected sessions"
      className="sticky top-0 z-20 mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 border border-rule bg-paper px-4 py-2"
    >
      <p className="text-[0.875rem]">
        <strong>{count} selected</strong>
      </p>
      {count === 0 ? null : (
        <button type="button" onClick={onClear} className="text-[0.75rem] text-ink-soft underline">
          Clear
        </button>
      )}
      {count < MAX_BATCH_SESSIONS ? null : (
        <p className="text-[0.75rem] text-ink-soft">
          {MAX_BATCH_SESSIONS} is the most in one batch.
        </p>
      )}
      <label htmlFor={modeId} className="ml-auto text-[0.8125rem]">
        Review
      </label>
      <select
        id={modeId}
        value={mode}
        onChange={(event) => setMode(event.target.value === "full" ? "full" : "newMessages")}
        className="h-9 rounded-xs border border-rule bg-panel px-2 text-[0.8125rem]"
      >
        <option value="newMessages">New messages</option>
        <option value="full">Full review</option>
      </select>
      <button
        type="button"
        onClick={() => onStart(mode)}
        disabled={count === 0 || starting}
        className="h-9 rounded-xs border border-ink bg-ink px-3 font-semibold text-panel-2 disabled:border-rule disabled:bg-panel disabled:text-faded"
      >
        Review and find fixes
      </button>
    </section>
  )
}
