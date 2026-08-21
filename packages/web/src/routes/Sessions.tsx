import { useEffect, useMemo, useState } from "react"
import { useSearchParams } from "react-router-dom"
import { getJson } from "../api/client.js"
import type { ApiError } from "../api/client.js"
import { parseSessionList } from "../api/parse.js"
import type { SessionListPayload } from "../api/types.js"
import { SessionExpired } from "../auth/SessionExpired.js"
import { FilterBar } from "../components/FilterBar.js"
import { SessionRow } from "../components/SessionRow.js"
import {
  EMPTY_FILTERS,
  type SessionFilters,
  changedFilters,
  localTimeZone,
  parseFilters,
  serializeFilters,
} from "../sessions/filters.js"
import { LoadingShell } from "../shell/LoadingShell.js"

type State =
  | { readonly phase: "loading"; readonly previous: SessionListPayload | null }
  | { readonly phase: "ready"; readonly payload: SessionListPayload }
  | { readonly phase: "failed"; readonly error: ApiError }

const panelClass = "border border-dashed border-rule bg-panel p-8 text-center"
const primaryButton =
  "mt-4 inline-flex items-center justify-center rounded-xs border border-ink bg-ink px-4 py-2 text-panel-2 transition-colors hover:bg-ink-2"

const NoResults = ({
  hasFilters,
  onClear,
}: { readonly hasFilters: boolean; readonly onClear: () => void }) => (
  <section className={panelClass}>
    <p className="text-[0.656rem] font-semibold uppercase tracking-[0.12em] text-stamp">
      {hasFilters ? "Nothing filed under these terms" : "No sessions captured"}
    </p>
    <h2 className="mt-2 text-[0.9375rem] font-semibold">
      {hasFilters ? "No sessions match these filters" : "There are no sessions to review yet"}
    </h2>
    <p className="mx-auto mt-2 max-w-md text-ink-soft">
      {hasFilters
        ? "The filters above are still applied. Widen them, or clear them to see every session you can read."
        : "Captured sessions will appear here once they are available to you."}
    </p>
    {hasFilters ? (
      <button type="button" onClick={onClear} className={primaryButton}>
        Clear filters
      </button>
    ) : null}
  </section>
)

const Denied = ({ onReset }: { readonly onReset: () => void }) => (
  <section className="border border-stamp/40 bg-panel p-8 text-center">
    <p className="text-[0.656rem] font-semibold uppercase tracking-[0.12em] text-stamp">
      Access withheld
    </p>
    <h2 className="mt-2 text-[0.9375rem] font-semibold">That project cannot be opened</h2>
    <p className="mx-auto mt-2 max-w-md text-ink-soft">
      It either does not exist or has not been shared with you.
    </p>
    <button type="button" onClick={onReset} className={primaryButton}>
      Back to all sessions
    </button>
  </section>
)

const ErrorState = ({ error }: { readonly error: ApiError }) => {
  const invalid = new Set([
    "invalidSearchQuery",
    "invalidPrNumber",
    "invalidCommit",
    "invalidTimeZone",
    "invalidRepo",
    "invalidBranch",
    "invalidPage",
    "invalidLimit",
    "invalidSort",
    "invalidRange",
    "invalidFilter",
  ]).has(error.code ?? "")
  const ambiguous = error.code === "ambiguousCommit"
  return (
    <section className="border border-err/40 bg-panel p-6" role="alert">
      <p className="text-[0.656rem] font-semibold uppercase tracking-[0.12em] text-err">
        {ambiguous
          ? "Commit prefix is ambiguous"
          : invalid
            ? "Check your search or filter"
            : "Retrieval failed"}
      </p>
      <p className="mt-2 text-ink-soft">
        {ambiguous
          ? "Use more of the commit SHA to identify one authorized commit."
          : invalid
            ? "The search or filter format is not valid. Update it and try again."
            : error.message}
      </p>
    </section>
  )
}

const ResultSummary = ({
  payload,
  filters,
}: { readonly payload: SessionListPayload; readonly filters: SessionFilters }) => {
  const scope = [
    filters.project,
    filters.user,
    filters.repo,
    filters.branch,
    filters.pr === null ? null : `PR #${filters.pr}`,
    filters.commit === null ? null : filters.commit,
  ].filter((value): value is string => value !== null)
  return (
    <div
      className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1"
      aria-live="polite"
    >
      <div>
        <p className="text-[0.875rem] font-semibold">
          {payload.pagination.total} {payload.pagination.total === 1 ? "session" : "sessions"}
          {filters.q === null ? null : (
            <span className="font-normal text-ink-soft"> match “{filters.q}”</span>
          )}
        </p>
        {scope.length === 0 ? null : (
          <p className="font-mono text-[0.72rem] text-ink-soft">Within {scope.join(" · ")}</p>
        )}
      </div>
      <p className="font-mono text-[0.72rem] text-ink-soft">Server-ranked and paginated</p>
    </div>
  )
}

const Pagination = ({
  page,
  totalPages,
  total,
  limit,
  onPage,
}: {
  readonly page: number
  readonly totalPages: number
  readonly total: number
  readonly limit: number
  readonly onPage: (page: number) => void
}) => {
  if (totalPages <= 1 && total === 0) return null
  const first = total === 0 || (page - 1) * limit >= total ? 0 : (page - 1) * limit + 1
  const last = first === 0 ? 0 : Math.min(page * limit, total)
  return (
    <nav
      className="mt-3 grid grid-cols-2 items-center gap-2 border-t border-rule pt-3 min-[600px]:grid-cols-[1fr_auto_1fr]"
      aria-label="Search results pagination"
    >
      <button
        type="button"
        onClick={() => onPage(page - 1)}
        disabled={page <= 1}
        className="h-9 rounded-xs border border-ink bg-panel-2 px-3 font-semibold disabled:cursor-not-allowed disabled:border-rule disabled:bg-panel disabled:text-faded min-[600px]:justify-self-start"
      >
        Previous
      </button>
      <p className="col-span-2 row-start-1 text-center min-[600px]:col-span-1 min-[600px]:col-start-2">
        <strong className="block text-[0.75rem]">
          Page {page} of {Math.max(totalPages, 1)}
        </strong>
        <span className="font-mono text-[0.72rem] text-ink-soft">
          Showing {first}–{last} of {total} sessions
        </span>
      </p>
      <button
        type="button"
        onClick={() => onPage(page + 1)}
        disabled={totalPages === 0 || page >= totalPages}
        className="h-9 rounded-xs border border-ink bg-panel-2 px-3 font-semibold disabled:cursor-not-allowed disabled:border-rule disabled:bg-panel disabled:text-faded min-[600px]:col-start-3 min-[600px]:justify-self-end"
      >
        Next
      </button>
    </nav>
  )
}

export const Sessions = () => {
  const [searchParams, setSearchParams] = useSearchParams()
  const query = searchParams.toString()
  const filters = useMemo(() => parseFilters(new URLSearchParams(query)), [query])
  // URL state stays authoritative, but date-aware requests must carry the local zone from their
  // first fetch. Avoid an all-time URL rewrite and avoid a second request for Today/custom.
  const effectiveFilters = useMemo(() => {
    if ((filters.range !== "today" && filters.range !== "custom") || filters.tz !== null)
      return filters
    const tz = localTimeZone()
    return tz === null ? filters : { ...filters, tz }
  }, [filters])
  const effectiveQuery = useMemo(
    () => serializeFilters(effectiveFilters).toString(),
    [effectiveFilters],
  )
  const [state, setState] = useState<State>({ phase: "loading", previous: null })

  const applyFilters = (next: SessionFilters) => setSearchParams(serializeFilters(next))
  const resetFilters = () => applyFilters(EMPTY_FILTERS)

  useEffect(() => {
    const controller = new AbortController()
    setState((current) => ({
      phase: "loading",
      previous:
        current.phase === "ready"
          ? current.payload
          : current.phase === "loading"
            ? current.previous
            : null,
    }))

    getJson(
      effectiveQuery === "" ? "/api/sessions" : `/api/sessions?${effectiveQuery}`,
      parseSessionList,
      { signal: controller.signal },
    ).then((result) => {
      if (controller.signal.aborted) return
      setState(
        result.ok
          ? { phase: "ready", payload: result.data }
          : { phase: "failed", error: result.error },
      )
    })
    return () => controller.abort()
  }, [effectiveQuery])

  useEffect(() => {
    if (effectiveFilters === filters) return
    setSearchParams(serializeFilters(effectiveFilters), { replace: true })
  }, [effectiveFilters, filters, setSearchParams])

  if (state.phase === "failed" && state.error.kind === "unauthorized") return <SessionExpired />

  const payload =
    state.phase === "ready" ? state.payload : state.phase === "loading" ? state.previous : null
  const loading = state.phase === "loading"
  const hasFilters = serializeFilters({ ...filters, page: 1 }).toString() !== ""

  return (
    <section>
      <h1 className="text-[1.375rem] font-semibold leading-tight">Sessions</h1>
      <div className="mt-4">
        <FilterBar
          filters={filters}
          options={
            payload?.filterOptions ?? { projects: [], authors: [], repositories: [], branches: [] }
          }
          onChange={applyFilters}
          onClear={resetFilters}
        />
      </div>
      <div className="mt-4" aria-busy={loading}>
        {loading && payload === null ? <LoadingShell label="Retrieving sessions" /> : null}
        {state.phase === "failed" ? (
          state.error.kind === "notFound" ? (
            <Denied onReset={resetFilters} />
          ) : (
            <ErrorState error={state.error} />
          )
        ) : null}
        {payload === null ? null : payload.sessions.length === 0 &&
          payload.pagination.total === 0 ? (
          <NoResults hasFilters={hasFilters} onClear={resetFilters} />
        ) : (
          <>
            <ResultSummary payload={payload} filters={filters} />
            <ul className="grid grid-cols-1 gap-1.5">
              {payload.sessions.map((session) => (
                <li key={session.id}>
                  <SessionRow session={session} to={`/sessions/${session.id}`} />
                </li>
              ))}
            </ul>
            <Pagination
              {...payload.pagination}
              onPage={(page) => applyFilters({ ...filters, page })}
            />
          </>
        )}
      </div>
    </section>
  )
}
