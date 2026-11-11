import { MAX_BATCH_SESSIONS } from "../sessions/reviewBatch.js"

type Props = {
  readonly count: number
  /** A start request is in flight. */
  readonly starting: boolean
  readonly onStart: () => void
  readonly onClear: () => void
}

export const ReviewBar = ({ count, starting, onStart, onClear }: Props) => (
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
      <p className="text-[0.75rem] text-ink-soft">{MAX_BATCH_SESSIONS} is the most in one batch.</p>
    )}
    <button
      type="button"
      onClick={onStart}
      disabled={count === 0 || starting}
      className="ml-auto h-9 rounded-xs border border-ink bg-ink px-3 font-semibold text-panel-2 disabled:border-rule disabled:bg-panel disabled:text-faded"
    >
      Review and find fixes
    </button>
  </section>
)
