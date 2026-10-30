import { useCallback, useEffect, useState } from "react"
import { Link, useSearchParams } from "react-router-dom"
import { type ApiError, client, request } from "../api/client.js"
import type { LearningRun, LearningSummary, ProjectSummary } from "../api/types.js"
import { SessionExpired } from "../auth/SessionExpired.js"
import { FIX_TYPE_LABEL, IMPACT_LABEL, PRIORITY_TONE, plural } from "../learnings/labels.js"
import { SkipButton } from "../learnings/SkipButton.js"
import { LoadingShell } from "../shell/LoadingShell.js"

type State =
  | { readonly phase: "loading" }
  | {
      readonly phase: "ready"
      readonly learnings: ReadonlyArray<LearningSummary>
      readonly latestRun: LearningRun | null
      readonly canEdit: boolean
    }
  | { readonly phase: "failed"; readonly error: ApiError }

type ProjectsState =
  | { readonly phase: "loading" }
  | { readonly phase: "ready"; readonly projects: ReadonlyArray<ProjectSummary> }
  | { readonly phase: "failed"; readonly error: ApiError }

/** A run that is going: started here, or found going when the page loaded. */
type RunState =
  | { readonly phase: "idle" }
  | { readonly phase: "running"; readonly runId: string; readonly startedAt: string }
  | { readonly phase: "failed"; readonly message: string }

/** How often a going run is checked. A run is two agents per batch, so minutes, not seconds. */
export const RUN_POLL_MS = 5_000

/** Plain words for why the server would not start a run. */
const RUN_REFUSED: Readonly<Record<string, string>> = {
  notEditable: "You need edit rights on this project to start a run.",
  noHarnessPath:
    "The server has no harness to check learnings against. Set LEARNINGS_HARNESS_REPO (or LEARNINGS_HARNESS_PATH) on the server.",
  projectNotFound: "This project could not be found.",
}

/**
 * How many learnings the page shows: the top few by default, since the server ranks them most
 * important first and the point is what to fix next. `?show=` keeps the choice.
 */
const SHOW_CHOICES = [
  { value: "5", label: "Top 5" },
  { value: "10", label: "Top 10" },
  { value: "20", label: "Top 20" },
  { value: "all", label: "All" },
  { value: "skipped", label: "Skipped" },
] as const
const DEFAULT_SHOW = "5"

/** The Show choice: how many to show, and whether it lists the skipped fixes instead. */
const showLimit = (
  value: string | null,
): { readonly value: string; readonly limit: number; readonly skipped: boolean } => {
  const choice = SHOW_CHOICES.find((c) => c.value === value)?.value ?? DEFAULT_SHOW
  const every = choice === "all" || choice === "skipped"
  return {
    value: choice,
    limit: every ? Number.POSITIVE_INFINITY : Number(choice),
    skipped: choice === "skipped",
  }
}

const runLine = (run: LearningRun | null): string =>
  run === null
    ? "No learning run yet"
    : `Last run ${new Date(run.startedAt).toLocaleString()} · ${run.status}`

/** A fix: the title links to its page, stretched over the card so the whole card opens it. */
const LearningCard = ({
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
      {row.impact === null ? null : (
        <p className="mt-2 text-[0.82rem]">
          <span className="font-semibold">Impact: {IMPACT_LABEL[row.impact] ?? row.impact}.</span>{" "}
          {row.impactReason}
        </p>
      )}
      <p className="mt-2 text-[0.82rem]">
        <span className="font-semibold">Fix ({FIX_TYPE_LABEL[row.fixType] ?? row.fixType}):</span>{" "}
        {row.fix}
      </p>
      {row.howItHelps === null ? null : (
        <p className="mt-1.5 text-[0.82rem]">
          <span className="font-semibold">How it helps:</span> {row.howItHelps}
        </p>
      )}
      <p className="mt-1.5 text-[0.82rem] text-ink-soft">
        Why {row.priority}: {row.priorityReason}
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

const controlClass =
  "h-9 rounded-xs border border-rule bg-panel px-2.5 font-mono text-[0.78rem] text-ink transition-colors focus:border-ink focus:outline-none"

export const Learnings = () => {
  const [searchParams, setSearchParams] = useSearchParams()
  const [projects, setProjects] = useState<ProjectsState>({ phase: "loading" })
  const [state, setState] = useState<State>({ phase: "loading" })
  const [run, setRun] = useState<RunState>({ phase: "idle" })
  // Bumped when a run ends, so the list loads again with what it wrote.
  const [reloadCount, setReloadCount] = useState(0)

  useEffect(() => {
    let active = true
    request(() => client.api.projects.$get()).then((result) => {
      if (!active) return
      setProjects(
        result.ok
          ? { phase: "ready", projects: result.data.projects }
          : { phase: "failed", error: result.error },
      )
    })
    return () => {
      active = false
    }
  }, [])

  const show = showLimit(searchParams.get("show"))
  // A skip or unskip changes one row in place; the filter below moves it between the lists.
  const onSkipChange = (id: string, skippedAt: string | null) =>
    setState((current) =>
      current.phase === "ready"
        ? {
            ...current,
            learnings: current.learnings.map((row) =>
              row.id === id ? { ...row, skippedAt } : row,
            ),
          }
        : current,
    )
  // Changes one search param and keeps the others, so the project and the count travel together.
  const setParam = (name: string, value: string) => {
    const next = new URLSearchParams(searchParams)
    next.set(name, value)
    setSearchParams(next)
  }

  // Learnings belong to one project; with none chosen, the first project the viewer can read.
  const project =
    searchParams.get("project") ??
    (projects.phase === "ready" ? (projects.projects[0]?.id ?? null) : null)

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadCount is never read, only bumped — a change is the reload.
  useEffect(() => {
    if (project === null) return
    let active = true
    request(() => client.api.learnings.$get({ query: { project } })).then((result) => {
      if (!active) return
      if (!result.ok) {
        setState({ phase: "failed", error: result.error })
        return
      }
      setState({
        phase: "ready",
        learnings: result.data.learnings,
        latestRun: result.data.latestRun,
        canEdit: result.data.canEdit,
      })
      // A run still going when the page loads (another tab, the weekly schedule) is shown and
      // waited on, so Run now cannot start a second one.
      const latest = result.data.latestRun
      setRun(
        latest?.status === "running"
          ? { phase: "running", runId: latest.id, startedAt: latest.startedAt }
          : { phase: "idle" },
      )
    })
    return () => {
      active = false
    }
  }, [project, reloadCount])

  // A project change starts from a blank list and no run of the old project's.
  // biome-ignore lint/correctness/useExhaustiveDependencies: project is never read — a change is the reset.
  useEffect(() => {
    setState({ phase: "loading" })
    setRun({ phase: "idle" })
  }, [project])

  const startRun = useCallback(() => {
    if (project === null) return
    request(() => client.api.learnings.runs.$post({ json: { project } })).then((result) => {
      if (result.ok) {
        setRun({ phase: "running", runId: result.data.runId, startedAt: new Date().toISOString() })
        return
      }
      // Someone else's run is going: reload, and the list's latest run is the one to wait on.
      if (result.error.code === "learningRunAlreadyRunning") {
        setReloadCount((count) => count + 1)
        return
      }
      setRun({
        phase: "failed",
        message: RUN_REFUSED[result.error.code ?? ""] ?? result.error.message,
      })
    })
  }, [project])

  const runningId = run.phase === "running" ? run.runId : null
  useEffect(() => {
    if (runningId === null) return
    let active = true
    const timer = setInterval(() => {
      request(() => client.api.learnings.runs[":id"].$get({ param: { id: runningId } })).then(
        (result) => {
          if (!active || !result.ok) return
          const { status, error } = result.data.run
          if (status === "running") return
          setRun(
            status === "failed"
              ? { phase: "failed", message: `The run failed: ${error ?? "no reason given"}` }
              : { phase: "idle" },
          )
          setReloadCount((count) => count + 1)
        },
      )
    }, RUN_POLL_MS)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [runningId])

  const failed = (error: ApiError) =>
    error.kind === "unauthorized" ? (
      <SessionExpired />
    ) : (
      <section className="border border-err/40 bg-panel p-6" role="alert">
        <p className="text-[0.656rem] font-semibold uppercase tracking-[0.12em] text-err">
          Retrieval failed
        </p>
        <p className="mt-2 text-ink-soft">{error.message}</p>
      </section>
    )
  if (projects.phase === "failed") return failed(projects.error)
  if (state.phase === "failed") return failed(state.error)
  // Skipped fixes appear only under Show "Skipped", and only they do.
  const listed =
    state.phase === "ready"
      ? state.learnings.filter((row) => (row.skippedAt !== null) === show.skipped)
      : []
  const empty = show.skipped
    ? {
        title: "No skipped fixes",
        detail: "A fix you skip moves here, and stays here when later runs find it again.",
      }
    : state.phase === "ready" && state.learnings.length > 0
      ? {
          title: "Every fix here is skipped",
          detail: 'Choose Show "Skipped" to see them, or to unskip one.',
        }
      : {
          title: "No learnings here yet",
          detail: "Learnings appear after a learning run reads this project's reviewed sessions.",
        }
  if (projects.phase === "loading") return <LoadingShell label="Retrieving learnings" />
  if (project === null)
    return (
      <section className="border border-dashed border-rule bg-panel p-8 text-center">
        <p className="text-ink-soft">You have no projects yet, so there are no learnings.</p>
      </section>
    )

  return (
    <div>
      <h1 className="mb-3 text-[1.375rem] font-semibold leading-tight">Fixes</h1>
      <div className="mb-4 mt-4 flex flex-wrap items-end justify-between gap-2">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-[0.656rem] font-semibold uppercase tracking-[0.12em] text-stamp">
              Project
            </span>
            <select
              className={controlClass}
              value={project}
              onChange={(e) => setParam("project", e.target.value)}
            >
              {projects.projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[0.656rem] font-semibold uppercase tracking-[0.12em] text-stamp">
              Show
            </span>
            <select
              className={controlClass}
              value={show.value}
              onChange={(e) => setParam("show", e.target.value)}
            >
              {SHOW_CHOICES.map((choice) => (
                <option key={choice.value} value={choice.value}>
                  {choice.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="flex flex-col items-end gap-1.5">
          <div className="flex flex-wrap items-center gap-3">
            {run.phase === "running" ? (
              <p className="font-mono text-[0.72rem] text-ink-soft">
                Running… (started {new Date(run.startedAt).toLocaleString()})
              </p>
            ) : state.phase === "ready" ? (
              <p className="font-mono text-[0.72rem] text-ink-soft">{runLine(state.latestRun)}</p>
            ) : null}
            <button
              type="button"
              onClick={startRun}
              disabled={run.phase === "running"}
              className="h-9 rounded-xs border border-rule px-3 text-[0.78rem] font-semibold transition-colors hover:border-ink disabled:cursor-default disabled:opacity-60 disabled:hover:border-rule"
            >
              Run now
            </button>
          </div>
          {run.phase === "failed" ? (
            <p role="alert" className="text-[0.82rem] text-err">
              {run.message}
            </p>
          ) : null}
        </div>
      </div>

      {state.phase === "loading" ? (
        <LoadingShell label="Retrieving learnings" />
      ) : listed.length === 0 ? (
        <section className="border border-dashed border-rule bg-panel p-8 text-center">
          <p className="text-[0.656rem] font-semibold uppercase tracking-[0.12em] text-stamp">
            {empty.title}
          </p>
          <p className="mx-auto mt-2 max-w-md text-ink-soft">{empty.detail}</p>
        </section>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="font-mono text-[0.72rem] text-ink-soft">
            Showing {Math.min(show.limit, listed.length)} of {listed.length}
          </p>
          {listed.slice(0, show.limit).map((row) => (
            <LearningCard
              key={row.id}
              row={row}
              search={searchParams.size === 0 ? "" : `?${searchParams}`}
              canEdit={state.canEdit}
              onSkipChange={onSkipChange}
            />
          ))}
        </div>
      )}
    </div>
  )
}
