import { Link } from "react-router-dom"
import type { ReviewBatchProject, ReviewBatchView } from "../api/types.js"

const PROJECT_STATE: Readonly<Record<ReviewBatchProject["state"], string>> = {
  waiting: "Waiting",
  running: "Finding fixes",
  done: "Done",
  failed: "Failed",
}

type Props = { readonly batch: ReviewBatchView }

export const ReviewBatchPanel = ({ batch }: Props) => {
  const counted = (state: ReviewBatchView["sessions"][number]["state"]): number =>
    batch.sessions.filter((session) => session.state === state).length
  const failed = batch.sessions.filter((session) => session.state === "failed")
  const settled =
    counted("reviewed") + counted("skipped") + counted("failed") + counted("notAllowed")
  const left = batch.sessions.length - settled
  return (
    <section aria-label="Review progress" className="mt-3 border border-rule bg-panel p-4">
      <h2 className="text-[0.9375rem] font-semibold">
        {batch.status === "running" ? "Reviewing and finding fixes" : "Review finished"}
      </h2>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[0.75rem]">
        <li>{counted("reviewed")} reviewed</li>
        <li>{counted("skipped")} skipped (already reviewed)</li>
        <li>{counted("failed")} failed</li>
        <li>{counted("notAllowed")} not allowed</li>
        {left === 0 ? null : <li>{left} to go</li>}
      </ul>
      {failed.length === 0 ? null : (
        <details className="mt-2 text-[0.8125rem]">
          <summary>
            Why {failed.length === 1 ? "1 review" : `${failed.length} reviews`} failed
          </summary>
          <ul className="mt-1 grid gap-1">
            {failed.map((session) => (
              <li key={session.sessionId}>
                <Link to={`/sessions/${session.sessionId}`} className="font-mono underline">
                  {session.sessionId}
                </Link>
                : {session.reason}
              </li>
            ))}
          </ul>
        </details>
      )}
      {batch.projects.length === 0 ? null : (
        <>
          <h3 className="mt-4 text-[0.656rem] font-semibold uppercase tracking-[0.12em] text-ink-soft">
            Find fixes
          </h3>
          <ul className="mt-1 grid gap-1">
            {batch.projects.map((project) => (
              <li
                key={project.projectId}
                className="flex flex-wrap items-baseline gap-x-2 text-[0.875rem]"
              >
                <span className="font-semibold">{project.name}</span>
                <span className="font-mono text-[0.72rem] text-ink-soft">
                  {PROJECT_STATE[project.state]}
                </span>
                {project.reason === null ? null : (
                  <span className="text-[0.8125rem] text-err">{project.reason}</span>
                )}
                {project.state === "done" ? (
                  <Link to={`/learnings?project=${project.projectId}`} className="underline">
                    See fixes for {project.name}
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}
