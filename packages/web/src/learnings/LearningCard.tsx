import { Link } from "react-router-dom"
import type { LearningSummary } from "../api/types.js"
import { asSentence, PRIORITY_TONE, plural } from "./labels.js"
import { SkipButton } from "./SkipButton.js"

/** A fix: the title links to its page, stretched over the card so the whole card opens it. */
export const LearningCard = ({
  row,
  search,
  canEdit,
  onSkipChange,
}: {
  readonly row: LearningSummary
  readonly search: string
  readonly canEdit: boolean
  readonly onSkipChange: (id: string, skippedAt: string | null) => void
}) => {
  return (
    <article className="relative border border-rule bg-panel p-4 break-words transition-colors hover:border-ink">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <Link
          to={`/learnings/${row.id}${search}`}
          className="text-[0.9375rem] font-semibold leading-snug after:absolute after:inset-0"
        >
          {row.title}
        </Link>
        <p className="font-mono text-[0.72rem] text-ink-soft">
          <span
            className={`mr-2 rounded-xs border px-1.5 py-0.5 font-semibold ${PRIORITY_TONE[row.priority] ?? PRIORITY_TONE.low}`}
          >
            {row.priority}
          </span>
          {`${plural(row.problemCount, "problem")} in ${plural(row.sessionCount, "session")}`}
        </p>
      </div>
      <p className="mt-1.5 text-ink-soft">{row.problem}</p>
      {row.impactReason === null ? null : (
        <p className="mt-2 text-[0.82rem]">
          <span className="font-semibold">Why it matters:</span> {asSentence(row.impactReason)}
        </p>
      )}
      <p className="mt-2 text-[0.82rem]">
        <span className="font-semibold">Fix:</span> {row.fixSummary ?? row.fix}
      </p>
      {canEdit ? (
        <div className="mt-3">
          <SkipButton
            learning={row}
            onChange={(updated) => onSkipChange(row.id, updated.skippedAt)}
          />
        </div>
      ) : null}
    </article>
  )
}
