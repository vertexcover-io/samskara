import { useEffect, useState } from "react"
import { Link, useSearchParams } from "react-router-dom"
import { type ApiError, client, request } from "../api/client.js"
import type { LearningProblem, LearningRun, LearningSummary, ProjectSummary } from "../api/types.js"
import { SessionExpired } from "../auth/SessionExpired.js"
import { LoadingShell } from "../shell/LoadingShell.js"

type State =
  | { readonly phase: "loading" }
  | {
      readonly phase: "ready"
      readonly learnings: ReadonlyArray<LearningSummary>
      readonly latestRun: LearningRun | null
    }
  | { readonly phase: "failed"; readonly error: ApiError }

type ProjectsState =
  | { readonly phase: "loading" }
  | { readonly phase: "ready"; readonly projects: ReadonlyArray<ProjectSummary> }
  | { readonly phase: "failed"; readonly error: ApiError }

type ProblemsState =
  | { readonly phase: "loading" }
  | { readonly phase: "ready"; readonly problems: ReadonlyArray<LearningProblem> }
  | { readonly phase: "failed"; readonly error: ApiError }

const PRIORITY_TONE: Readonly<Record<string, string>> = {
  high: "border-err/40 text-err",
  medium: "border-stamp/40 text-stamp",
  low: "border-rule text-ink-soft",
}

const FIX_TYPE_LABEL: Readonly<Record<string, string>> = {
  skill: "Skill",
  code: "Code",
  project_guidelines: "Project guidelines",
  knowledge_base: "Knowledge base",
  human: "The person",
}

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? "" : "s"}`

const runLine = (run: LearningRun | null): string =>
  run === null
    ? "No learning run yet"
    : `Last run ${new Date(run.startedAt).toLocaleString()} · ${run.status}`

const Problems = ({ learningId }: { readonly learningId: string }) => {
  const [state, setState] = useState<ProblemsState>({ phase: "loading" })

  useEffect(() => {
    let active = true
    request(() => client.api.learnings[":id"].$get({ param: { id: learningId } })).then(
      (result) => {
        if (!active) return
        setState(
          result.ok
            ? { phase: "ready", problems: result.data.problems }
            : { phase: "failed", error: result.error },
        )
      },
    )
    return () => {
      active = false
    }
  }, [learningId])

  if (state.phase === "loading") return <p className="mt-3 text-ink-soft">Loading problems…</p>
  if (state.phase === "failed")
    return <p className="mt-3 text-err">The problems could not be retrieved.</p>
  return (
    <ul className="mt-3 flex flex-col gap-2">
      {state.problems.map((problem) => (
        <li key={problem.id} className="border border-rule bg-panel-2 p-3">
          <p className="font-semibold leading-snug">{problem.title}</p>
          <p className="mt-1 text-[0.82rem] text-ink-soft">{problem.description}</p>
          <p className="mt-1.5 font-mono text-[0.72rem] text-ink-soft">
            {problem.severity} ·{" "}
            <Link to={`/sessions/${problem.sessionId}?tab=review`} className="underline">
              the session
            </Link>
          </p>
        </li>
      ))}
    </ul>
  )
}

const LearningCard = ({ row }: { readonly row: LearningSummary }) => {
  const [open, setOpen] = useState(false)
  return (
    <article className="border border-rule bg-panel p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="text-[0.9375rem] font-semibold leading-snug">{row.title}</p>
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
      <p className="mt-2 text-[0.82rem]">
        <span className="font-semibold">Fix ({FIX_TYPE_LABEL[row.fixType] ?? row.fixType}):</span>{" "}
        {row.fix}
      </p>
      <p className="mt-1.5 text-[0.82rem] text-ink-soft">
        Why {row.priority}: {row.priorityReason}
      </p>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="mt-3 h-8 rounded-xs border border-rule px-3 text-[0.78rem] font-semibold transition-colors hover:border-ink"
      >
        {open ? "Hide problems" : "Show problems"}
      </button>
      {open ? <Problems learningId={row.id} /> : null}
    </article>
  )
}

const controlClass =
  "h-9 rounded-xs border border-rule bg-panel px-2.5 font-mono text-[0.78rem] text-ink transition-colors focus:border-ink focus:outline-none"

const HowThisWorks = () => (
  <section className="border border-rule bg-panel-2 p-4 text-[0.82rem] leading-relaxed text-ink-soft">
    <p>
      <span className="font-mono text-[0.656rem] font-semibold uppercase tracking-[0.12em] text-stamp">
        How this page works
      </span>
    </p>
    <p className="mt-1.5">
      Session reviews find problems. Once a week, a learning run reads the project's problems that
      no run has read yet, groups them by cause, checks each group against the agent harness, and
      writes what to change. A cause that comes back joins the learning it already has.
    </p>
    <p className="mt-1.5">
      To run one now:{" "}
      <code className="font-mono text-[0.78rem] text-custody">
        samskara learn --project PROJECT_ID
      </code>
      .
    </p>
  </section>
)

export const Learnings = () => {
  const [searchParams, setSearchParams] = useSearchParams()
  const [projects, setProjects] = useState<ProjectsState>({ phase: "loading" })
  const [state, setState] = useState<State>({ phase: "loading" })

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

  // Learnings belong to one project; with none chosen, the first project the viewer can read.
  const project =
    searchParams.get("project") ??
    (projects.phase === "ready" ? (projects.projects[0]?.id ?? null) : null)

  useEffect(() => {
    if (project === null) return
    let active = true
    setState({ phase: "loading" })
    request(() => client.api.learnings.$get({ query: { project } })).then((result) => {
      if (!active) return
      setState(
        result.ok
          ? { phase: "ready", learnings: result.data.learnings, latestRun: result.data.latestRun }
          : { phase: "failed", error: result.error },
      )
    })
    return () => {
      active = false
    }
  }, [project])

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
  if (projects.phase === "loading") return <LoadingShell label="Retrieving learnings" />
  if (project === null)
    return (
      <section className="border border-dashed border-rule bg-panel p-8 text-center">
        <p className="text-ink-soft">You have no projects yet, so there are no learnings.</p>
      </section>
    )

  return (
    <div>
      <h1 className="mb-3 text-[1.375rem] font-semibold leading-tight">Learnings</h1>
      <HowThisWorks />
      <div className="mb-4 mt-4 flex flex-wrap items-end justify-between gap-2">
        <label className="flex flex-col gap-1">
          <span className="text-[0.656rem] font-semibold uppercase tracking-[0.12em] text-stamp">
            Project
          </span>
          <select
            className={controlClass}
            value={project}
            onChange={(e) => setSearchParams(new URLSearchParams({ project: e.target.value }))}
          >
            {projects.projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        {state.phase === "ready" ? (
          <p className="font-mono text-[0.72rem] text-ink-soft">{runLine(state.latestRun)}</p>
        ) : null}
      </div>

      {state.phase === "loading" ? (
        <LoadingShell label="Retrieving learnings" />
      ) : state.learnings.length === 0 ? (
        <section className="border border-dashed border-rule bg-panel p-8 text-center">
          <p className="text-[0.656rem] font-semibold uppercase tracking-[0.12em] text-stamp">
            No learnings here yet
          </p>
          <p className="mx-auto mt-2 max-w-md text-ink-soft">
            Learnings appear after a learning run reads this project's reviewed sessions.
          </p>
        </section>
      ) : (
        <div className="flex flex-col gap-3">
          {state.learnings.map((row) => (
            <LearningCard key={row.id} row={row} />
          ))}
        </div>
      )}
    </div>
  )
}
