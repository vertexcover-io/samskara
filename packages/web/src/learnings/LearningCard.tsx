import { Link } from "react-router-dom"
import type { LearningDetailPayload, LearningSummary } from "../api/types.js"
import { dayDate } from "../time.js"
import { DecisionControls, DecisionNote } from "./DecisionControls.js"
import { asSentence, PRIORITY_TONE, plural } from "./labels.js"

/** A fix: the title links to its page, stretched over the card so the whole card opens it. */
export const LearningCard = ({
  row,
  search,
  canEdit,
  onDecisionChange,
  mark,
}: {
  readonly row: LearningSummary
  readonly search: string
  readonly canEdit: boolean
  /** The fix as the server returns it after a decision; the list merges it into its row. */
  readonly onDecisionChange: (updated: LearningDetailPayload["learning"]) => void
  /** On a run page: whether that run created this fix or updated it. */
  readonly mark?: "new" | "updated" | null | undefined
}) => {
  return (
    <article className="relative border border-rule bg-panel p-4 break-words transition-colors hover:border-ink">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <Link
          to={`/learnings/${row.id}${search}`}
          className="min-w-0 text-[0.9375rem] font-semibold leading-snug wrap-anywhere after:absolute after:inset-0"
        >
          {row.title}
        </Link>
        <p className="font-mono text-[0.72rem] text-ink-soft">
          {mark === undefined || mark === null ? null : (
            <span className="mr-2 rounded-xs border border-custody/40 px-1.5 py-0.5 font-semibold text-custody">
              {mark}
            </span>
          )}
          {row.decision === "accepted" ? (
            <span className="mr-2 rounded-xs border border-ok/40 px-1.5 py-0.5 font-semibold text-ok">
              accepted
            </span>
          ) : null}
          <span
            className={`mr-2 rounded-xs border px-1.5 py-0.5 font-semibold ${PRIORITY_TONE[row.priority] ?? PRIORITY_TONE.low}`}
          >
            {row.priority}
          </span>
          {`${plural(row.problemCount, "problem")} in ${plural(row.sessionCount, "session")}`}
        </p>
      </div>
      {row.firstSeenAt === null || row.lastSeenAt === null ? null : (
        <p className="mt-1.5 font-mono text-[0.72rem] text-ink-soft">
          {`first seen ${dayDate(row.firstSeenAt)} · last seen ${dayDate(row.lastSeenAt)} · seen in ${plural(row.sessionsLast7Days, "session")} in the last 7 days`}
        </p>
      )}
      <div className="mt-1.5">
        <DecisionNote learning={row} />
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
          <DecisionControls learning={row} onChange={onDecisionChange} />
        </div>
      ) : null}
    </article>
  )
}
