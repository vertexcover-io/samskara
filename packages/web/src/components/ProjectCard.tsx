import type { ReactNode } from "react"
import { Link } from "react-router-dom"
import type { ProjectSummary } from "../api/types.js"
import { absoluteTime } from "../time.js"

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
  readonly to: string
}

export const ProjectCard = ({ project, to }: Props) => {
  const { name, slug, owner, sessionCount, lastActiveAt } = project
  const dormant = sessionCount === 0

  return (
    <Link
      to={to}
      className="flex w-full flex-col gap-3 border border-rule bg-panel-2 p-4 text-left shadow-card transition-colors hover:border-ink-soft"
    >
      <div className="min-w-0">
        <h2 className="truncate text-[0.9375rem] font-semibold">{name}</h2>
        <p className="truncate font-mono text-[0.78rem] text-custody">/{slug}</p>
        {owner.type === "org" ? (
          <p className="truncate text-[0.656rem] font-semibold uppercase tracking-[0.12em] text-ink-soft">
            org · {owner.slug}
          </p>
        ) : null}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Sessions">{sessionCount}</Field>
        <Field label="Last active">
          {lastActiveAt === null ? (
            <span className="text-faded italic underline decoration-dotted">unavailable</span>
          ) : (
            absoluteTime(lastActiveAt)
          )}
        </Field>
      </div>

      {dormant ? (
        <output className="block border-t border-rule-soft pt-2 text-[0.656rem] font-semibold uppercase tracking-[0.12em] text-warn">
          No sessions captured
        </output>
      ) : null}
    </Link>
  )
}
