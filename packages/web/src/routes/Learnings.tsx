import { useEffect, useMemo, useState } from "react"
import { useSearchParams } from "react-router-dom"
import { type ApiError, client, request } from "../api/client.js"
import type { ProjectSummary } from "../api/types.js"
import { SessionExpired } from "../auth/SessionExpired.js"
import { LoadingShell } from "../shell/LoadingShell.js"

type LearningStatus = "candidate" | "accepted" | "superseded"
type Audience = "agent" | "human"

type LearningRow = {
  readonly id: string
  readonly projectId: string
  readonly audience: Audience
  readonly category: string
  readonly title: string
  readonly detail: string
  readonly evidence: ReadonlyArray<{ readonly seq: number; readonly what: string }>
  readonly status: LearningStatus
  readonly occurrenceCount: number
}

type CommonRow = {
  readonly fingerprint: string
  readonly audience: Audience
  readonly category: string
  readonly title: string
  readonly detail: string
  readonly status: string
  readonly projectCount: number
  readonly totalOccurrences: number
  readonly projectNames: ReadonlyArray<string>
}

type Filters = {
  readonly project: string | null
  readonly audience: Audience | null
  readonly status: LearningStatus | null
  readonly view: "project" | "common"
}

const parseFilters = (params: URLSearchParams): Filters => {
  const audience = params.get("audience")
  const status = params.get("status")
  return {
    project: params.get("project"),
    audience: audience === "agent" || audience === "human" ? audience : null,
    status:
      status === "candidate" || status === "accepted" || status === "superseded" ? status : null,
    view: params.get("view") === "common" ? "common" : "project",
  }
}

const serializeFilters = (filters: Filters): URLSearchParams => {
  const params = new URLSearchParams()
  if (filters.project !== null) params.set("project", filters.project)
  if (filters.audience !== null) params.set("audience", filters.audience)
  if (filters.status !== null) params.set("status", filters.status)
  if (filters.view === "common") params.set("view", "common")
  return params
}

const AUDIENCE_LABEL: Record<Audience, string> = {
  agent: "For agents",
  human: "For humans",
}

const STATUS_LABEL: Record<LearningStatus, string> = {
  candidate: "Candidate",
  accepted: "Accepted",
  superseded: "Retired",
}

type State =
  | { readonly phase: "loading" }
  | ({ readonly phase: "ready" } & (
      | { readonly view: "project"; readonly rows: ReadonlyArray<LearningRow> }
      | { readonly view: "common"; readonly rows: ReadonlyArray<CommonRow> }
    ))
  | { readonly phase: "failed"; readonly error: ApiError }

type ProjectsState =
  | { readonly phase: "loading" }
  | { readonly phase: "ready"; readonly projects: ReadonlyArray<ProjectSummary> }

const evidenceLine = (row: LearningRow): string =>
  row.evidence.length === 0
    ? "No evidence recorded"
    : `${row.evidence.length} evidence ${row.evidence.length === 1 ? "pointer" : "pointers"} in the review`

const StatusWord = ({ status }: { readonly status: LearningStatus }) => (
  <span
    className={
      status === "accepted"
        ? "font-semibold text-ok"
        : status === "superseded"
          ? "text-faded line-through"
          : "font-semibold text-stamp"
    }
  >
    {STATUS_LABEL[status]}
  </span>
)

const LearningCard = ({
  row,
  projectName,
  onStatus,
  busy,
}: {
  readonly row: LearningRow
  readonly projectName: string | null
  readonly onStatus: (id: string, status: LearningStatus) => void
  readonly busy: boolean
}) => (
  <article className="border border-rule bg-panel p-4">
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
      <p className="text-[0.9375rem] font-semibold leading-snug">{row.title}</p>
      <p className="font-mono text-[0.72rem] text-ink-soft">
        <StatusWord status={row.status} />
        {` · seen ${row.occurrenceCount} ${row.occurrenceCount === 1 ? "session" : "sessions"}`}
      </p>
    </div>
    <p className="mt-1.5 text-ink-soft">{row.detail}</p>
    <p className="mt-2 font-mono text-[0.72rem] text-ink-soft">
      {AUDIENCE_LABEL[row.audience]} · {row.category}
      {projectName === null ? null : ` · ${projectName}`} · {evidenceLine(row)}
    </p>
    {row.status === "accepted" ? (
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => onStatus(row.id, "superseded")}
          className="h-8 rounded-xs border border-rule px-3 text-[0.78rem] font-semibold transition-colors hover:border-ink disabled:cursor-not-allowed disabled:text-faded"
        >
          Retire
        </button>
      </div>
    ) : row.status === "candidate" ? (
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => onStatus(row.id, "accepted")}
          className="h-8 rounded-xs border border-ink bg-ink px-3 text-[0.78rem] font-semibold text-panel-2 transition-colors hover:bg-ink-2 disabled:cursor-not-allowed"
        >
          Accept
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => onStatus(row.id, "superseded")}
          className="h-8 rounded-xs border border-rule px-3 text-[0.78rem] font-semibold transition-colors hover:border-ink disabled:cursor-not-allowed disabled:text-faded"
        >
          Reject
        </button>
      </div>
    ) : (
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => onStatus(row.id, "candidate")}
          className="h-8 rounded-xs border border-rule px-3 text-[0.78rem] font-semibold transition-colors hover:border-ink disabled:cursor-not-allowed disabled:text-faded"
        >
          Back to candidate
        </button>
      </div>
    )}
  </article>
)

const CommonCard = ({ row }: { readonly row: CommonRow }) => (
  <article className="border border-rule bg-panel p-4">
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
      <p className="text-[0.9375rem] font-semibold leading-snug">{row.title}</p>
      <p className="font-mono text-[0.72rem] text-ink-soft">
        {row.projectCount} projects · {row.totalOccurrences} sessions total
      </p>
    </div>
    <p className="mt-1.5 text-ink-soft">{row.detail}</p>
    <p className="mt-2 font-mono text-[0.72rem] text-ink-soft">
      {AUDIENCE_LABEL[row.audience]} · {row.category} · {row.projectNames.join(" · ")}
    </p>
    <p className="mt-2 text-[0.82rem] text-ink-soft">
      The same lesson in several projects is usually about the tools, not the project. Accept or
      retire it in each project's own view.
    </p>
  </article>
)

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
      Lessons come out of session reviews and wait here as candidates. Nothing accepts a lesson by
      itself — only a person reading this page does.{" "}
      <strong className="font-semibold text-ink">Accept</strong> marks a lesson as real,{" "}
      <strong className="font-semibold text-ink">Reject</strong> retires one you disagree with,{" "}
      <strong className="font-semibold text-ink">Retire</strong> takes an accepted lesson out of
      circulation, and a retired lesson can be brought back to candidate.
    </p>
    <p className="mt-1.5">
      Where accepted lessons go: nowhere until someone exports them. Running{" "}
      <code className="font-mono text-[0.78rem] text-custody">samskara learn --write</code> in a
      project checkout writes the accepted lessons of that project into the repo as files under{" "}
      <code className="font-mono text-[0.78rem] text-custody">.harness/knowledge/</code> for the
      next session to read. Rejecting or retiring keeps them out of that export.
    </p>
  </section>
)

export const Learnings = () => {
  const [searchParams, setSearchParams] = useSearchParams()
  const filters = useMemo(() => parseFilters(searchParams), [searchParams])
  const [state, setState] = useState<State>({ phase: "loading" })
  const [projects, setProjects] = useState<ProjectsState>({ phase: "loading" })
  const [busyId, setBusyId] = useState<string | null>(null)

  const query = useMemo(() => serializeFilters(filters).toString(), [filters])

  useEffect(() => {
    let active = true
    setState({ phase: "loading" })
    // Parsed from the serialized query inside the effect so `query` is the single dependency;
    // reading `filters` here instead would need the object itself in the deps, which changes
    // identity every render.
    const current = parseFilters(new URLSearchParams(query))
    const load =
      current.view === "common"
        ? request(() => client.api.learnings.common.$get())
        : request(() =>
            client.api.learnings.$get({
              query: {
                ...(current.project === null ? {} : { projectId: current.project }),
                ...(current.audience === null ? {} : { audience: current.audience }),
                ...(current.status === null ? {} : { status: current.status }),
              },
            }),
          )
    load.then((result) => {
      if (!active) return
      if (!result.ok) {
        setState({ phase: "failed", error: result.error })
        return
      }
      // The two endpoints answer differently shaped rows; each branch narrows to its own.
      setState(
        current.view === "common"
          ? {
              phase: "ready",
              view: "common",
              rows: result.data.learnings as unknown as ReadonlyArray<CommonRow>,
            }
          : {
              phase: "ready",
              view: "project",
              rows: result.data.learnings as unknown as ReadonlyArray<LearningRow>,
            },
      )
    })
    return () => {
      active = false
    }
  }, [query])

  useEffect(() => {
    let active = true
    request(() => client.api.projects.$get()).then((result) => {
      if (!active) return
      setProjects(
        result.ok
          ? { phase: "ready", projects: result.data.projects }
          : { phase: "ready", projects: [] },
      )
    })
    return () => {
      active = false
    }
  }, [])

  const apply = (next: Partial<Filters>) =>
    setSearchParams(serializeFilters({ ...filters, ...next }))

  const changeStatus = async (id: string, status: LearningStatus) => {
    setBusyId(id)
    const result = await request(() =>
      client.api.learnings[":id"].status.$patch({
        param: { id },
        json: { status },
      }),
    )
    setBusyId(null)
    if (!result.ok) {
      setState((current) =>
        current.phase === "failed" ? current : { phase: "failed", error: result.error },
      )
      return
    }
    setState((current) => {
      if (current.phase !== "ready" || current.view !== "project") return current
      return {
        ...current,
        // The response row types status as string (jsonb serialization); the PATCH only ever
        // answers with the status this page sent, which is already a LearningStatus.
        rows: current.rows.map((row) =>
          row.id === id ? { ...row, status: result.data.learning.status as LearningStatus } : row,
        ),
      }
    })
  }

  if (state.phase === "loading") return <LoadingShell label="Retrieving lessons" />
  if (state.phase === "failed") {
    if (state.error.kind === "unauthorized") return <SessionExpired />
    return (
      <section className="border border-err/40 bg-panel p-6" role="alert">
        <p className="text-[0.656rem] font-semibold uppercase tracking-[0.12em] text-err">
          Retrieval failed
        </p>
        <p className="mt-2 text-ink-soft">{state.error.message}</p>
      </section>
    )
  }

  const projectNameOf = (projectId: string): string | null => {
    if (projects.phase !== "ready") return null
    return projects.projects.find((p) => p.id === projectId)?.name ?? null
  }

  return (
    <div>
      <h1 className="mb-3 text-[1.375rem] font-semibold leading-tight">Lessons</h1>
      <HowThisWorks />
      <div className="mb-4 mt-4 flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1">
          <span className="text-[0.656rem] font-semibold uppercase tracking-[0.12em] text-stamp">
            View
          </span>
          <select
            className={controlClass}
            value={filters.view}
            onChange={(e) => apply({ view: e.target.value === "common" ? "common" : "project" })}
          >
            <option value="project">One lesson per project</option>
            <option value="common">Common across projects</option>
          </select>
        </label>
        {filters.view === "project" ? (
          <>
            <label className="flex flex-col gap-1">
              <span className="text-[0.656rem] font-semibold uppercase tracking-[0.12em] text-stamp">
                Project
              </span>
              <select
                className={controlClass}
                value={filters.project ?? ""}
                onChange={(e) => apply({ project: e.target.value === "" ? null : e.target.value })}
              >
                <option value="">All projects you can read</option>
                {projects.phase === "ready"
                  ? projects.projects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))
                  : null}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[0.656rem] font-semibold uppercase tracking-[0.12em] text-stamp">
                Audience
              </span>
              <select
                className={controlClass}
                value={filters.audience ?? ""}
                onChange={(e) =>
                  apply({
                    audience:
                      e.target.value === "agent" || e.target.value === "human"
                        ? e.target.value
                        : null,
                  })
                }
              >
                <option value="">Both audiences</option>
                <option value="agent">For agents</option>
                <option value="human">For humans</option>
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[0.656rem] font-semibold uppercase tracking-[0.12em] text-stamp">
                Status
              </span>
              <select
                className={controlClass}
                value={filters.status ?? ""}
                onChange={(e) =>
                  apply({
                    status:
                      e.target.value === "candidate" ||
                      e.target.value === "accepted" ||
                      e.target.value === "superseded"
                        ? (e.target.value as LearningStatus)
                        : null,
                  })
                }
              >
                <option value="">Every status</option>
                <option value="candidate">Candidates</option>
                <option value="accepted">Accepted</option>
                <option value="superseded">Retired</option>
              </select>
            </label>
          </>
        ) : null}
      </div>

      {state.view === "project" ? (
        state.rows.length === 0 ? (
          <section className="border border-dashed border-rule bg-panel p-8 text-center">
            <p className="text-[0.656rem] font-semibold uppercase tracking-[0.12em] text-stamp">
              No lessons here yet
            </p>
            <h2 className="mt-2 text-[0.9375rem] font-semibold">
              Reviews have not produced lessons for this view
            </h2>
            <p className="mx-auto mt-2 max-w-md text-ink-soft">
              Lessons appear after sessions are reviewed — run{" "}
              <code className="font-mono text-[0.78rem] text-custody">samskara review</code> or
              widen the filters above.
            </p>
          </section>
        ) : (
          <div className="flex flex-col gap-3">
            {state.rows.map((row) => (
              <LearningCard
                key={row.id}
                row={row}
                projectName={projectNameOf(row.projectId)}
                onStatus={changeStatus}
                busy={busyId === row.id}
              />
            ))}
          </div>
        )
      ) : state.rows.length === 0 ? (
        <section className="border border-dashed border-rule bg-panel p-8 text-center">
          <p className="text-[0.656rem] font-semibold uppercase tracking-[0.12em] text-stamp">
            No shared lessons yet
          </p>
          <h2 className="mt-2 text-[0.9375rem] font-semibold">
            No lesson appears in two or more of your projects
          </h2>
          <p className="mx-auto mt-2 max-w-md text-ink-soft">
            When the same lesson shows up in several projects, it is listed here as a pattern rather
            than as separate rows.
          </p>
        </section>
      ) : (
        <div className="flex flex-col gap-3">
          {state.rows.map((row) => (
            <CommonCard key={row.fingerprint} row={row} />
          ))}
        </div>
      )}
    </div>
  )
}
