import { useEffect, useMemo, useState } from "react"
import { useSearchParams } from "react-router-dom"
import { getJson } from "../api/client.js"
import { parseSessionList } from "../api/parse.js"
import type { ApiError, SessionSummary } from "../api/types.js"
import { SessionExpired } from "../auth/SessionExpired.js"
import { FilterBar } from "../components/FilterBar.js"
import { SessionRow } from "../components/SessionRow.js"
import {
  EMPTY_FILTERS,
  type SessionFilters,
  parseFilters,
  serializeFilters,
  sortSessions,
  withinRange,
} from "../sessions/filters.js"
import { LoadingShell } from "../shell/LoadingShell.js"

type State =
  | { readonly phase: "loading" }
  | { readonly phase: "ready"; readonly sessions: ReadonlyArray<SessionSummary> }
  | { readonly phase: "failed"; readonly error: ApiError }

const distinct = (
  sources: ReadonlyArray<ReadonlyArray<SessionSummary>>,
  pick: (session: SessionSummary) => string,
  pinned: string | null,
): ReadonlyArray<string> => {
  const values = new Set(sources.flat().map(pick))
  if (pinned !== null) values.add(pinned)
  return [...values].sort()
}

const NoResults = ({ onClear }: { onClear: () => void }) => (
  <section className="border border-dashed border-rule bg-panel p-8 text-center">
    <p className="text-[0.656rem] font-semibold uppercase tracking-[0.12em] text-stamp">
      Nothing filed under these terms
    </p>
    <h2 className="mt-2 text-[0.9375rem] font-semibold">No sessions match these filters</h2>
    <p className="mx-auto mt-2 max-w-md text-ink-soft">
      The filters above are still applied. Widen them, or clear them to see every session you can
      read.
    </p>
    <button
      type="button"
      onClick={onClear}
      className="mt-4 inline-flex items-center justify-center rounded-xs border border-ink bg-ink px-4 py-2 text-panel-2 transition-colors hover:bg-ink-2"
    >
      Clear filters
    </button>
  </section>
)

const Denied = ({ onReset }: { onReset: () => void }) => (
  <section className="border border-stamp/40 bg-panel p-8 text-center">
    <p className="text-[0.656rem] font-semibold uppercase tracking-[0.12em] text-stamp">
      Access withheld
    </p>
    <h2 className="mt-2 text-[0.9375rem] font-semibold">That project cannot be opened</h2>
    <p className="mx-auto mt-2 max-w-md text-ink-soft">
      It either does not exist or has not been shared with you.
    </p>
    <button
      type="button"
      onClick={onReset}
      className="mt-4 inline-flex items-center justify-center rounded-xs border border-ink bg-ink px-4 py-2 text-panel-2 transition-colors hover:bg-ink-2"
    >
      Back to all sessions
    </button>
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

type ResultProps = {
  readonly state: State
  readonly onClear: () => void
}

const Result = ({ state, onClear }: ResultProps) => {
  if (state.phase === "loading") return <LoadingShell label="Retrieving sessions" />

  if (state.phase === "failed") {
    if (state.error.kind === "notFound") return <Denied onReset={onClear} />
    return <ErrorState error={state.error} />
  }

  if (state.sessions.length === 0) return <NoResults onClear={onClear} />

  return (
    <ul className="grid grid-cols-1 gap-1.5">
      {state.sessions.map((session) => (
        <li key={session.id}>
          <SessionRow session={session} to={`/sessions/${session.id}`} />
        </li>
      ))}
    </ul>
  )
}

export const Sessions = () => {
  const [searchParams, setSearchParams] = useSearchParams()
  const [state, setState] = useState<State>({ phase: "loading" })
  const [vocabulary, setVocabulary] = useState<ReadonlyArray<SessionSummary>>([])

  const query = serializeFilters(parseFilters(searchParams)).toString()
  const filters = useMemo(() => parseFilters(new URLSearchParams(query)), [query])

  const applyFilters = (next: SessionFilters) => setSearchParams(serializeFilters(next))

  useEffect(() => {
    let active = true
    setState({ phase: "loading" })

    getJson(query === "" ? "/api/sessions" : `/api/sessions?${query}`, parseSessionList).then(
      (result) => {
        if (!active) return
        setState(
          result.ok
            ? { phase: "ready", sessions: result.data }
            : { phase: "failed", error: result.error },
        )
      },
    )

    return () => {
      active = false
    }
  }, [query])

  useEffect(() => {
    let active = true

    getJson("/api/sessions", parseSessionList).then((result) => {
      if (active && result.ok) setVocabulary(result.data)
    })

    return () => {
      active = false
    }
  }, [])

  const onScreen = state.phase === "ready" ? state.sessions : []
  const sources = [vocabulary, onScreen]
  const users = distinct(sources, (session) => session.userLogin, filters.user)

  // The slug is the filter value, but the name is what people recognise.
  const projects = useMemo(() => {
    const bySlug = new Map<string, string>()
    for (const session of [...vocabulary, ...onScreen]) {
      bySlug.set(session.projectSlug, session.projectName)
    }
    if (filters.project !== null && !bySlug.has(filters.project)) {
      bySlug.set(filters.project, filters.project)
    }
    return [...bySlug]
      .map(([value, label]) => ({ value, label }))
      .sort((a, b) => a.label.localeCompare(b.label))
  }, [vocabulary, onScreen, filters.project])

  // The server already applies the named ranges it knows; only the custom
  // window and the sort order are resolved here.
  const visible = useMemo(() => {
    const scoped =
      filters.range === "custom"
        ? onScreen.filter((session) => withinRange(filters, session.lastActiveAt))
        : onScreen
    return sortSessions(scoped, filters.sort)
  }, [onScreen, filters])

  const shown: State = state.phase === "ready" ? { ...state, sessions: visible } : state

  if (state.phase === "failed" && state.error.kind === "unauthorized") {
    return <SessionExpired />
  }

  return (
    <section>
      <h1 className="text-[1.375rem] font-semibold leading-tight">Sessions</h1>

      <div className="mt-4">
        <FilterBar filters={filters} projects={projects} users={users} onChange={applyFilters} />
      </div>

      <div className="mt-4">
        <Result state={shown} onClear={() => applyFilters(EMPTY_FILTERS)} />
      </div>
    </section>
  )
}
