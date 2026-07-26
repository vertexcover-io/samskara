import type { ReactNode } from "react"
import type { SessionSummary } from "../api/types.js"

const Unavailable = () => (
  <span className="text-faded italic underline decoration-dotted">unavailable</span>
)

const formatTimestamp = (iso: string): string => {
  const parsed = new Date(iso)
  return Number.isNaN(parsed.getTime()) ? iso : parsed.toISOString().replace("T", " ").slice(0, 16)
}

const formatDuration = (ms: number): string => {
  const totalMinutes = Math.floor(ms / 60_000)
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return hours === 0 ? `${minutes}m` : `${hours}h ${minutes}m`
}

const STATUS_MARK: Readonly<Record<string, string>> = {
  complete: "●",
  partial: "◐",
  empty: "○",
}

const Field = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="min-w-0">
    <p className="text-[0.656rem] font-semibold uppercase tracking-[0.12em] text-ink-soft">
      {label}
    </p>
    <p className="truncate font-mono text-[0.78rem] tabular-nums">{children}</p>
  </div>
)

type Props = {
  readonly session: SessionSummary
  readonly onOpen: (session: SessionSummary) => void
}

export const SessionRow = ({ session, onOpen }: Props) => {
  const { title, projectName, userLogin, model, durationMs, tokensTotal, status, lastActiveAt } =
    session

  return (
    <button
      type="button"
      onClick={() => onOpen(session)}
      className="flex w-full flex-col gap-3 border border-rule bg-panel-2 p-4 text-left transition-shadow hover:shadow-[0_6px_18px_-8px_rgba(26,28,32,0.35)]"
    >
      <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-2">
        <h2 className="min-w-0 truncate text-[0.9375rem] font-semibold">
          {title ?? <span className="text-faded italic">untitled session</span>}
        </h2>
        <output className="shrink-0 text-[0.656rem] font-semibold uppercase tracking-[0.12em] text-custody">
          {STATUS_MARK[status] ?? "○"} {status}
        </output>
      </div>

      <div className="grid grid-cols-2 gap-3 min-[560px]:grid-cols-3">
        <Field label="Project">{projectName}</Field>
        <Field label="User">{userLogin}</Field>
        <Field label="Model">{model ?? <Unavailable />}</Field>
        <Field label="Duration">
          {durationMs === null ? <Unavailable /> : formatDuration(durationMs)}
        </Field>
        <Field label="Tokens">{tokensTotal.toLocaleString("en-US")}</Field>
        <Field label="Last active">{formatTimestamp(lastActiveAt)}</Field>
      </div>
    </button>
  )
}
