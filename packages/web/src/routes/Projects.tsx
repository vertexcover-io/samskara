import { useEffect, useState } from "react"
import { useNavigate } from "react-router-dom"
import { getJson } from "../api/client.js"
import { parseProjectList } from "../api/parse.js"
import type { ApiError, ProjectSummary } from "../api/types.js"
import { SessionExpired } from "../auth/SessionExpired.js"
import { ProjectCard } from "../components/ProjectCard.js"
import { LoadingShell } from "../shell/LoadingShell.js"

type Loaded = { readonly projects: ReadonlyArray<ProjectSummary> }

type State =
  | { readonly phase: "loading" }
  | ({ readonly phase: "ready" } & Loaded)
  | { readonly phase: "failed"; readonly error: ApiError }

const EmptyState = () => (
  <section className="border border-dashed border-rule bg-panel p-8 text-center">
    <p className="text-[0.656rem] font-semibold uppercase tracking-[0.12em] text-stamp">
      No case files yet
    </p>
    <h2 className="mt-2 text-[0.9375rem] font-semibold">Nothing has been filed here</h2>
    <p className="mx-auto mt-2 max-w-md text-ink-soft">
      Send your first capture from the CLI and this shelf fills itself. Run{" "}
      <code className="font-mono text-[0.78rem] text-custody">samskara capture</code> inside a
      project to file its sessions.
    </p>
  </section>
)

const ErrorState = ({ error }: { error: ApiError }) => (
  <section className="border border-err/40 bg-panel p-6">
    <p className="text-[0.656rem] font-semibold uppercase tracking-[0.12em] text-err">
      Retrieval failed
    </p>
    <p className="mt-2 text-ink-soft">{error.message}</p>
  </section>
)

export const Projects = () => {
  const [state, setState] = useState<State>({ phase: "loading" })
  const navigate = useNavigate()

  useEffect(() => {
    let active = true

    getJson("/api/projects", parseProjectList).then((result) => {
      if (!active) return
      setState(
        result.ok
          ? { phase: "ready", projects: result.data }
          : { phase: "failed", error: result.error },
      )
    })

    return () => {
      active = false
    }
  }, [])

  if (state.phase === "loading") return <LoadingShell label="Retrieving case files" />
  if (state.phase === "failed") {
    if (state.error.kind === "unauthorized") return <SessionExpired />
    return <ErrorState error={state.error} />
  }
  if (state.projects.length === 0) return <EmptyState />

  return (
    <section>
      <h1 className="text-[1.375rem] font-semibold leading-tight">Projects</h1>
      <ul className="mt-4 grid grid-cols-1 gap-4 min-[560px]:grid-cols-2 min-[840px]:grid-cols-3">
        {state.projects.map((project) => (
          <li key={project.id}>
            <ProjectCard
              project={project}
              onOpen={({ slug }) => navigate(`/sessions?project=${encodeURIComponent(slug)}`)}
            />
          </li>
        ))}
      </ul>
    </section>
  )
}
