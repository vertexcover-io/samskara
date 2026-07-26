import type { ReactNode } from "react"
import type { ProjectSummary } from "../api/types.js"

const formatTimestamp = (iso: string): string => {
  const parsed = new Date(iso)
  return Number.isNaN(parsed.getTime()) ? iso : parsed.toISOString().replace("T", " ").slice(0, 16)
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
  readonly project: ProjectSummary
  readonly onOpen: (project: ProjectSummary) => void
}

export const ProjectCard = ({ project, onOpen }: Props) => {
  const { name, slug, sessionCount, lastActiveAt, lastSessionTitle } = project
  const dormant = sessionCount === 0

  return (
    <button
      type="button"
      onClick={() => onOpen(project)}
      className="flex w-full flex-col gap-3 border border-rule bg-panel-2 p-4 text-left transition-shadow hover:shadow-[0_6px_18px_-8px_rgba(26,28,32,0.35)]"
    >
      <div className="min-w-0">
        <h2 className="truncate text-[0.9375rem] font-semibold">{name}</h2>
        <p className="truncate font-mono text-[0.78rem] text-custody">/{slug}</p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Sessions">{sessionCount}</Field>
        <Field label="Last active">
          {lastActiveAt === null ? (
            <span className="text-faded italic underline decoration-dotted">unavailable</span>
          ) : (
            formatTimestamp(lastActiveAt)
          )}
        </Field>
      </div>

      {dormant ? (
        <output className="block border-t border-rule-soft pt-2 text-[0.656rem] font-semibold uppercase tracking-[0.12em] text-warn">
          No sessions captured
        </output>
      ) : (
        <p className="truncate border-t border-rule-soft pt-2 text-ink-soft">
          {lastSessionTitle ?? (
            <span className="text-faded italic underline decoration-dotted">untitled session</span>
          )}
        </p>
      )}
    </button>
  )
}
