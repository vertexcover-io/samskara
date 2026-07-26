import type { SessionSummary } from "../api/types.js"

const Unavailable = () => (
  <span className="text-faded italic underline decoration-dotted">unavailable</span>
)

const formatDuration = (ms: number): string => {
  const totalMinutes = Math.round(ms / 60_000)
  if (totalMinutes < 1) return "under a minute"
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (hours === 0) return `${minutes}m`
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`
}

const formatTokens = (total: number): string =>
  total >= 1000 ? `${(total / 1000).toFixed(1)}k tokens` : `${total} tokens`

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

export const relativeTime = (iso: string, now: number = Date.now()): string => {
  const at = new Date(iso).getTime()
  if (Number.isNaN(at)) return "unknown"

  const elapsed = now - at
  if (elapsed < MINUTE) return "just now"
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)} min ago`
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)} h ago`
  if (elapsed < 2 * DAY) return "Yesterday"
  if (elapsed < 7 * DAY) return `${Math.floor(elapsed / DAY)} d ago`
  if (elapsed < 30 * DAY) return `${Math.floor(elapsed / (7 * DAY))} wk ago`
  return new Date(at).toISOString().slice(0, 10)
}

type Props = {
  readonly session: SessionSummary
  readonly onOpen: (session: SessionSummary) => void
}

export const SessionRow = ({ session, onOpen }: Props) => {
  const { title, projectName, userLogin, model, durationMs, tokensTotal, lastActiveAt } = session

  return (
    <button
      type="button"
      onClick={() => onOpen(session)}
      className="grid w-full grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 gap-y-1 border border-rule bg-panel-2 px-4 py-3 text-left transition-colors hover:border-ink-soft min-[900px]:grid-cols-[auto_minmax(0,1fr)_minmax(0,14rem)_auto]"
    >
      <span
        aria-hidden="true"
        className="mt-1.5 size-2 shrink-0 rounded-pill border border-custody bg-paper"
      />

      <span className="min-w-0">
        <span className="block truncate text-[0.875rem] font-semibold">
          {title ?? <span className="text-faded italic">untitled session</span>}
        </span>
        <span className="mt-0.5 block truncate font-mono text-[0.72rem] text-ink-soft">
          {userLogin} · {model ?? <Unavailable />} ·{" "}
          {durationMs === null ? "--:--" : formatDuration(durationMs)} · {formatTokens(tokensTotal)}
        </span>
      </span>

      <span className="col-start-2 truncate font-mono text-[0.72rem] text-faded min-[900px]:col-start-3 min-[900px]:self-center">
        {projectName}
      </span>

      <span className="col-start-2 font-mono text-[0.72rem] text-ink-soft min-[900px]:col-start-4 min-[900px]:self-center min-[900px]:text-right">
        {relativeTime(lastActiveAt)}
      </span>
    </button>
  )
}
