import { Link } from "react-router-dom"
import { repoLabel } from "../api/repo.js"
import type { SessionSummary } from "../api/types.js"
import { absoluteTime, relativeTime } from "../time.js"

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

const TOKEN_UNITS = [
  { scale: 1_000_000_000, suffix: "B" },
  { scale: 1_000_000, suffix: "M" },
  { scale: 1_000, suffix: "k" },
] as const

const formatTokens = (total: number): string => {
  const unit = TOKEN_UNITS.find(({ scale }) => total >= scale)
  if (unit === undefined) return `${total} tokens`
  return `${(total / unit.scale).toFixed(1)}${unit.suffix} tokens`
}

const HL = /\[\[hl\]\]([\s\S]*?)\[\[\/hl\]\]/g

// Odd segments are the matched text; even segments are the surrounding text.
const markSnippet = (text: string) =>
  text
    .split(HL)
    // biome-ignore lint/suspicious/noArrayIndexKey: snippet segments have no stable identity
    .map((part, i) => (i % 2 === 1 ? <mark key={i}>{part}</mark> : part))

type Props = {
  readonly session: SessionSummary
  readonly to: string
}

export const SessionRow = ({ session, to }: Props) => {
  const { title, projectName, userLogin, repo, durationMs, tokensTotal, lastActiveAt, snippet } =
    session

  return (
    <Link
      to={to}
      className="grid w-full grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 gap-y-0.5 border border-rule bg-panel-2 px-4 py-2 text-left transition-colors hover:border-ink-soft min-[900px]:grid-cols-[auto_minmax(0,1fr)_minmax(0,14rem)_auto]"
    >
      <span
        aria-hidden="true"
        className="mt-1.5 size-2 shrink-0 rounded-pill border border-custody bg-paper"
      />

      <span className="min-w-0">
        <span className="block truncate text-[0.875rem] font-semibold">
          {title ?? <span className="text-faded italic">untitled session</span>}
        </span>
        {snippet === null ? null : (
          <span className="block truncate text-[0.8rem] text-ink-soft">{markSnippet(snippet)}</span>
        )}
        <span className="block truncate font-mono text-[0.72rem] text-ink-soft">
          {userLogin} · {repo === null ? null : `${repoLabel(repo)} · `}
          {durationMs === null ? <Unavailable /> : formatDuration(durationMs)} ·{" "}
          {formatTokens(tokensTotal)}
        </span>
      </span>

      <span className="col-start-2 truncate font-mono text-[0.72rem] text-faded min-[900px]:col-start-3 min-[900px]:self-center">
        {projectName}
      </span>

      <time
        dateTime={lastActiveAt}
        title={absoluteTime(lastActiveAt)}
        className="col-start-2 font-mono text-[0.72rem] text-ink-soft min-[900px]:col-start-4 min-[900px]:self-center min-[900px]:text-right"
      >
        {relativeTime(lastActiveAt)}
      </time>
    </Link>
  )
}
