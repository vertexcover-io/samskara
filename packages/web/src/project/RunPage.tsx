import { useEffect, useState } from "react"
import { Link } from "react-router-dom"
import { type ApiError, client, request } from "../api/client.js"
import type { LearningDetailPayload, LearningRun, LearningSummary } from "../api/types.js"
import { SessionExpired } from "../auth/SessionExpired.js"
import { LearningCard } from "../learnings/LearningCard.js"
import { runStatusClass, runWork } from "../learnings/labels.js"
import { LoadingShell } from "../shell/LoadingShell.js"
import { absoluteTime } from "../time.js"
import { tabPath } from "./ProjectTabs.js"

type State =
  | { readonly phase: "loading" }
  | {
      readonly phase: "ready"
      readonly run: LearningRun
      readonly learnings: ReadonlyArray<LearningSummary>
      readonly canEdit: boolean
    }
  | { readonly phase: "failed"; readonly error: ApiError }

const OTHER_PROJECTS_RUN: ApiError = {
  kind: "notFound",
  code: "runNotFound",
  message: "This project has no such run.",
}

export const RunPage = ({
  projectId,
  runId,
}: {
  readonly projectId: string
  readonly runId: string
}) => {
  const [state, setState] = useState<State>({ phase: "loading" })

  useEffect(() => {
    let active = true
    setState({ phase: "loading" })
    Promise.all([
      request(() => client.api.learnings.runs[":id"].$get({ param: { id: runId } })),
      request(() => client.api.learnings.$get({ query: { project: projectId, run: runId } })),
    ]).then(([run, list]) => {
      if (!active) return
      if (!run.ok) return setState({ phase: "failed", error: run.error })
      if (!list.ok) return setState({ phase: "failed", error: list.error })
      // The run route checks access to the run's own project, not to the one in this URL.
      if (run.data.run.projectId !== projectId)
        return setState({ phase: "failed", error: OTHER_PROJECTS_RUN })
      setState({
        phase: "ready",
        run: run.data.run,
        learnings: list.data.learnings,
        canEdit: list.data.canEdit,
      })
    })
    return () => {
      active = false
    }
  }, [projectId, runId])

  const onDecisionChange = (updated: LearningDetailPayload["learning"]) =>
    setState((current) =>
      current.phase === "ready"
        ? {
            ...current,
            learnings: current.learnings.map((row) =>
              row.id === updated.id ? { ...row, ...updated } : row,
            ),
          }
        : current,
    )

  const back = (
    <Link
      to={tabPath(projectId, "runs")}
      className="text-[0.78rem] font-semibold text-custody hover:underline"
    >
      ← All runs
    </Link>
  )
  if (state.phase === "loading") return <LoadingShell label="Retrieving the run" />
  if (state.phase === "failed")
    return state.error.kind === "unauthorized" ? (
      <SessionExpired />
    ) : (
      <div className="flex flex-col gap-3">
        {back}
        <section className="border border-err/40 bg-panel p-6" role="alert">
          <p className="text-[0.656rem] font-semibold uppercase tracking-[0.12em] text-err">
            Retrieval failed
          </p>
          <p className="mt-2 text-ink-soft">{state.error.message}</p>
        </section>
      </div>
    )

  const { run, learnings } = state
  const created = learnings.filter((row) => row.runMark === "new").length
  const updated = learnings.filter((row) => row.runMark === "updated").length
  const open = run.status === "waiting" || run.status === "running"
  return (
    <div>
      {back}
      <h2 className="mt-2 text-[1.125rem] font-semibold">{`Run · ${absoluteTime(run.startedAt)}`}</h2>
      <p className="mb-4 mt-1 font-mono text-[0.72rem] text-ink-soft">
        <span className={`mr-2 ${runStatusClass(run.status)}`}>{run.status}</span>
        {run.finishedAt === null ? null : `finished ${absoluteTime(run.finishedAt)} · `}
        {runWork(created, updated)}
      </p>
      {run.status === "failed" && run.error !== null ? (
        <p role="alert" className="mb-4 text-[0.82rem] text-err">
          {run.error}
        </p>
      ) : null}
      {learnings.length === 0 ? (
        <section className="border border-dashed border-rule bg-panel p-8 text-center">
          <p className="text-[0.656rem] font-semibold uppercase tracking-[0.12em] text-stamp">
            {open ? "This run has not finished yet" : "This run changed no fixes"}
          </p>
          {open ? (
            <p className="mx-auto mt-2 max-w-md text-ink-soft">
              Reload the page once it finishes to see the fixes it changed.
            </p>
          ) : null}
        </section>
      ) : (
        <div className="flex flex-col gap-3">
          {learnings.map((row) => (
            <LearningCard
              key={row.id}
              row={row}
              search=""
              canEdit={state.canEdit}
              onDecisionChange={onDecisionChange}
              mark={row.runMark}
            />
          ))}
        </div>
      )}
    </div>
  )
}
