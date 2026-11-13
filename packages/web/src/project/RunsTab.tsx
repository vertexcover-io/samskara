import { useEffect, useState } from "react"
import { Link } from "react-router-dom"
import { type ApiError, client, request } from "../api/client.js"
import type { ListedRun } from "../api/types.js"
import { SessionExpired } from "../auth/SessionExpired.js"
import { plural, runStatusClass, runWork } from "../learnings/labels.js"
import { LoadingShell } from "../shell/LoadingShell.js"
import { absoluteTime } from "../time.js"
import { tabPath } from "./ProjectTabs.js"
import { RunNow } from "./RunNow.js"

/**
 * How often an open run is checked. A run is two agents per batch, so minutes, not seconds. Each
 * check asks about that one run; the list, with every run's counts, is read again once it ends.
 */
export const RUN_POLL_MS = 5_000

type State =
  | { readonly phase: "loading" }
  | {
      readonly phase: "ready"
      readonly runs: ReadonlyArray<ListedRun>
      readonly canEdit: boolean
    }
  | { readonly phase: "failed"; readonly error: ApiError }

/** Where a run's page lives, under the project's Runs tab. */
export const runPath = (projectId: string, runId: string): string =>
  `${tabPath(projectId, "runs")}/${encodeURIComponent(runId)}`

const isOpen = (status: string): boolean => status === "waiting" || status === "running"

/** When a run ended, or that it has not yet. */
const runProgress = (run: ListedRun): string =>
  run.status === "waiting"
    ? "waiting to start"
    : run.status === "running"
      ? "running…"
      : run.finishedAt === null
        ? run.status
        : `finished ${absoluteTime(run.finishedAt)}`

/** One run: the whole card opens its page. */
export const RunCard = ({
  projectId,
  run,
}: {
  readonly projectId: string
  readonly run: ListedRun
}) => (
  <article className="relative border border-rule bg-panel p-4 transition-colors hover:border-ink">
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
      <Link
        to={runPath(projectId, run.id)}
        className="text-[0.9375rem] font-semibold leading-snug after:absolute after:inset-0"
      >
        {absoluteTime(run.startedAt)}
      </Link>
      <span className={runStatusClass(run.status)}>{run.status}</span>
    </div>
    <p className="mt-1 font-mono text-[0.72rem] text-ink-soft">
      {`${runProgress(run)} · ${runWork(run.fixesCreated, run.fixesUpdated)}`}
    </p>
    {run.status === "failed" && run.error !== null ? (
      <p className="mt-1.5 text-[0.82rem] text-err">{run.error}</p>
    ) : null}
  </article>
)

export const RunsTab = ({
  projectId,
  fixRunEveryDays,
}: {
  readonly projectId: string
  readonly fixRunEveryDays: number
}) => {
  const [state, setState] = useState<State>({ phase: "loading" })
  // Bumped to read the list again: after Run now, and when an open run ends.
  const [reloadCount, setReloadCount] = useState(0)

  // The list is not blanked to loading here: the poll reads it every few seconds.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadCount is never read, only bumped — a change is the reload.
  useEffect(() => {
    let active = true
    request(() => client.api.learnings.runs.$get({ query: { project: projectId } })).then(
      (result) => {
        if (!active) return
        if (result.ok) {
          setState({ phase: "ready", runs: result.data.runs, canEdit: result.data.canEdit })
          return
        }
        // A network or server failure keeps the list and the next poll tries again; a 404 or an
        // expired session will not pass, so it shows the error, which also ends the polling.
        const passing = result.error.kind === "network" || result.error.kind === "server"
        setState((previous) =>
          previous.phase === "ready" && passing
            ? previous
            : { phase: "failed", error: result.error },
        )
      },
    )
    return () => {
      active = false
    }
  }, [projectId, reloadCount])

  // At most one run of a project is open at a time.
  const openRunId =
    state.phase === "ready" ? (state.runs.find((run) => isOpen(run.status))?.id ?? null) : null
  useEffect(() => {
    if (openRunId === null) return
    let active = true
    const check = async () => {
      const result = await request(() =>
        client.api.learnings.runs[":id"].$get({ param: { id: openRunId } }),
      )
      if (!active) return
      if (!result.ok) {
        // A network or server failure waits for the next check; a 404 or an expired session
        // will not pass, so it shows the error, which also ends the checks.
        if (result.error.kind !== "network" && result.error.kind !== "server")
          setState({ phase: "failed", error: result.error })
        return
      }
      const { status, finishedAt } = result.data.run
      if (!isOpen(status)) {
        // Ended: read the list once more, for its finish time and what it created and updated.
        setReloadCount((count) => count + 1)
        return
      }
      setState((previous) =>
        previous.phase === "ready"
          ? {
              ...previous,
              runs: previous.runs.map((run) =>
                run.id === openRunId ? { ...run, status, finishedAt } : run,
              ),
            }
          : previous,
      )
    }
    const timer = setInterval(() => void check(), RUN_POLL_MS)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [openRunId])

  if (state.phase === "loading") return <LoadingShell label="Retrieving fix runs" />
  if (state.phase === "failed")
    return state.error.kind === "unauthorized" ? (
      <SessionExpired />
    ) : (
      <section className="border border-err/40 bg-panel p-6" role="alert">
        <p className="text-[0.656rem] font-semibold uppercase tracking-[0.12em] text-err">
          Retrieval failed
        </p>
        <p className="mt-2 text-ink-soft">{state.error.message}</p>
      </section>
    )

  const latest = state.runs[0]
  return (
    <div>
      {/* Both lines on the left: Run now's refusal message grows the right side, and a line
          beside it would float to that side's middle. */}
      <div className="mb-4 flex flex-wrap items-start justify-between gap-2">
        <div className="font-mono text-[0.72rem] text-ink-soft">
          <p>{`Automatic fix run every ${plural(fixRunEveryDays, "day")}`}</p>
          <p className="mt-1">
            {latest === undefined
              ? "No fix run yet"
              : `Last run ${absoluteTime(latest.startedAt)} · ${latest.status}`}
          </p>
        </div>
        {state.canEdit ? (
          <RunNow projectId={projectId} onStarted={() => setReloadCount((count) => count + 1)} />
        ) : null}
      </div>
      {state.runs.length === 0 ? (
        <section className="border border-dashed border-rule bg-panel p-8 text-center">
          <p className="text-[0.656rem] font-semibold uppercase tracking-[0.12em] text-stamp">
            No fix runs yet
          </p>
          <p className="mx-auto mt-2 max-w-md text-ink-soft">
            A fix run reads this project's reviewed sessions and turns their problems into fixes.
          </p>
        </section>
      ) : (
        <div className="flex flex-col gap-3">
          {state.runs.map((run) => (
            <RunCard key={run.id} projectId={projectId} run={run} />
          ))}
        </div>
      )}
    </div>
  )
}
