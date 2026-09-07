import type { ReactNode } from "react"
import { useEffect, useRef, useState } from "react"
import { Link, useParams } from "react-router-dom"
import { type ApiError, client, request } from "../api/client.js"
import type { ProjectDetail as ProjectDetailPayload, SessionSummary } from "../api/types.js"
import { SessionExpired } from "../auth/SessionExpired.js"
import { DeleteProjectDialog } from "../components/DeleteProjectDialog.js"
import { RepoLink } from "../components/RepoLink.js"
import { SessionRow } from "../components/SessionRow.js"
import { LoadingShell } from "../shell/LoadingShell.js"

type State =
  | { readonly phase: "loading" }
  | {
      readonly phase: "ready"
      readonly project: ProjectDetailPayload
      readonly viewerCanDelete: boolean
    }
  | { readonly phase: "failed"; readonly error: ApiError }

const Field = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="min-w-0">
    <p className="text-[0.656rem] font-semibold uppercase tracking-[0.12em] text-ink-soft">
      {label}
    </p>
    <p className="truncate font-mono text-[0.9375rem]">{children}</p>
  </div>
)

const ErrorState = ({ error }: { error: ApiError }) => (
  <section className="border border-err/40 bg-panel p-6">
    <p className="text-[0.656rem] font-semibold uppercase tracking-[0.12em] text-err">
      Retrieval failed
    </p>
    <p className="mt-2 text-ink-soft">{error.message}</p>
  </section>
)

const OwnerValue = ({ owner }: { owner: ProjectDetailPayload["owner"] }) =>
  owner.type === "org" ? (
    <Link to={`/orgs/${encodeURIComponent(owner.slug)}`} className="text-custody hover:underline">
      org · {owner.slug}
    </Link>
  ) : (
    owner.slug
  )

export const ProjectDetail = () => {
  const { id } = useParams()
  const [state, setState] = useState<State>({ phase: "loading" })
  const [deleting, setDeleting] = useState(false)
  const [recent, setRecent] = useState<ReadonlyArray<SessionSummary> | null>(null)
  const deleteTriggerRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    let active = true

    request(() => client.api.projects[":id"].$get({ param: { id: id ?? "" } })).then((result) => {
      if (!active) return
      setState(
        result.ok
          ? {
              phase: "ready",
              project: result.data.project,
              viewerCanDelete: result.data.viewerCanDelete,
            }
          : { phase: "failed", error: result.error },
      )
    })

    return () => {
      active = false
    }
  }, [id])

  useEffect(() => {
    if (!id) return
    let active = true

    request(() =>
      client.api.sessions.$get({ query: { project: id, sort: "recent", limit: "5" } }),
    ).then((result) => {
      if (!active) return
      setRecent(result.ok ? result.data.sessions : [])
    })

    return () => {
      active = false
    }
  }, [id])

  if (state.phase === "loading") return <LoadingShell label="Retrieving the project" />
  if (state.phase === "failed") {
    if (state.error.kind === "unauthorized") return <SessionExpired />
    return <ErrorState error={state.error} />
  }

  const { project, viewerCanDelete } = state

  return (
    <section>
      <h1 className="text-[1.375rem] font-semibold leading-tight">{project.name}</h1>
      <div className="mt-4 grid grid-cols-2 gap-4 border border-rule bg-panel-2 p-4 shadow-card min-[560px]:grid-cols-4">
        <Field label="Slug">{project.slug}</Field>
        <Field label="Owner">
          <OwnerValue owner={project.owner} />
        </Field>
        {project.repo === null ? null : (
          <Field label="Repository">
            <RepoLink repo={project.repo} />
          </Field>
        )}
        <Field label="Sessions">{project.sessionCount}</Field>
      </div>
      <div className="mt-6 flex items-baseline justify-between gap-4">
        <h2 className="text-[0.9375rem] font-semibold">Recent sessions</h2>
        {project.sessionCount > 0 ? (
          <Link
            to={`/sessions?project=${encodeURIComponent(project.id)}`}
            className="text-[0.78rem] font-semibold text-custody hover:underline"
          >
            All {project.sessionCount} sessions
          </Link>
        ) : null}
      </div>

      {recent === null ? (
        <p className="mt-2 text-ink-soft">Loading sessions…</p>
      ) : recent.length === 0 ? (
        <p className="mt-2 border border-rule-soft bg-panel p-4 text-ink-soft">
          Nothing captured here yet. Run{" "}
          <code className="font-mono text-[0.78rem]">samskara watch</code> in this project to start
          recording sessions.
        </p>
      ) : (
        <ul className="mt-2 flex flex-col gap-2">
          {recent.map((session) => (
            <li key={session.id}>
              <SessionRow
                session={session}
                to={`/sessions/${encodeURIComponent(session.id)}`}
                showProject={false}
              />
            </li>
          ))}
        </ul>
      )}

      {viewerCanDelete ? (
        <div className="mt-8 border border-err/40 bg-panel p-4">
          <h2 className="text-[0.656rem] font-semibold uppercase tracking-[0.12em] text-err">
            Delete this project
          </h2>
          <p className="mt-1 text-ink-soft">
            Removes the project and every session captured in it. This cannot be undone.
          </p>
          <button
            ref={deleteTriggerRef}
            type="button"
            onClick={() => setDeleting(true)}
            className="mt-3 min-h-11 border border-err/60 bg-panel-2 px-4 py-2 text-[0.78rem] font-semibold text-err"
          >
            Delete project
          </button>
        </div>
      ) : null}

      <DeleteProjectDialog
        open={deleting}
        project={{ id: project.id, slug: project.slug, sessionCount: project.sessionCount }}
        onClose={() => setDeleting(false)}
        restoreFocusTo={() => deleteTriggerRef.current}
      />
    </section>
  )
}
