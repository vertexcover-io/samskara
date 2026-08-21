import { useEffect, useMemo, useState } from "react"
import { useSearchParams } from "react-router-dom"
import { getJson } from "../api/client.js"
import { parseSyncStatusRows } from "../api/parse.js"
import type { ApiError, SyncStatusRow } from "../api/types.js"
import { SessionExpired } from "../auth/SessionExpired.js"
import { LoadingShell } from "../shell/LoadingShell.js"
import {
  COLUMNS,
  type Column,
  type Direction,
  type TableState,
  filterRows,
  nextDirection,
  parseState,
  sortRows,
  toParams,
} from "../sync/table.js"
import { absoluteTime, relativeTime } from "../time.js"

type Loaded = { readonly rows: ReadonlyArray<SyncStatusRow> }

type State =
  | { readonly phase: "loading" }
  | ({ readonly phase: "ready" } & Loaded)
  | { readonly phase: "failed"; readonly error: ApiError }

const inputClass =
  "mt-1 h-9 w-full min-w-0 rounded-xs border border-rule bg-panel-2 px-2 font-mono text-[0.78rem] leading-none text-ink transition-colors hover:border-ink-soft focus-visible:border-custody"
const labelClass = "block text-[0.656rem] font-semibold uppercase tracking-[0.12em] text-ink-soft"

const EmptyState = () => (
  <section className="border border-dashed border-rule bg-panel p-8 text-center">
    <p className="text-[0.656rem] font-semibold uppercase tracking-[0.12em] text-stamp">
      No users yet
    </p>
    <h2 className="mt-2 text-[0.9375rem] font-semibold">There is nothing to report</h2>
  </section>
)

const NoMatches = ({
  state,
  onClear,
}: { readonly state: TableState; readonly onClear: () => void }) => (
  <section className="border border-dashed border-rule bg-panel p-8 text-center">
    <p className="text-[0.656rem] font-semibold uppercase tracking-[0.12em] text-stamp">
      No rows match
    </p>
    <h2 className="mt-2 text-[0.9375rem] font-semibold">
      Nothing matches {state.user === "" ? null : `user "${state.user}"`}
      {state.user !== "" && state.project !== "" ? " and " : null}
      {state.project === "" ? null : `project "${state.project}"`}
    </h2>
    <button
      type="button"
      onClick={onClear}
      className="mt-4 inline-flex items-center justify-center rounded-xs border border-ink bg-ink px-4 py-2 text-panel-2 transition-colors hover:bg-ink-2"
    >
      Clear filters
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

const UserCell = ({ row }: { row: SyncStatusRow }) => (
  <td className="border border-rule px-2 py-1 align-top">
    {row.avatarUrl === null ? null : (
      <img
        src={row.avatarUrl}
        alt=""
        className="mr-2 inline-block size-5 rounded-pill align-middle"
      />
    )}
    <span className="font-semibold">{row.githubLogin}</span>
    {row.name === null ? null : (
      <span className="block text-[0.72rem] text-ink-soft">{row.name}</span>
    )}
  </td>
)

const ProjectCell = ({ row }: { row: SyncStatusRow }) => {
  if (row.projectId === null) {
    return <td className="border border-rule px-2 py-1 align-top text-faded italic">no projects</td>
  }
  return (
    <td className="border border-rule px-2 py-1 align-top">
      <span>{row.projectName}</span>
      <span className="block font-mono text-[0.72rem] text-ink-soft">{row.projectSlug}</span>
    </td>
  )
}

const SyncedCell = ({ lastSyncedAt }: { lastSyncedAt: string | null }) => (
  <td className="border border-rule px-2 py-1 align-top">
    {lastSyncedAt === null ? (
      "never"
    ) : (
      <time dateTime={lastSyncedAt} title={absoluteTime(lastSyncedAt)}>
        {relativeTime(lastSyncedAt)}
      </time>
    )}
  </td>
)

const ARIA_SORT: Readonly<Record<Direction, "ascending" | "descending">> = {
  asc: "ascending",
  desc: "descending",
}

const COLUMN_LABEL: Readonly<Record<Column, string>> = {
  user: "User",
  project: "Project",
  sessions: "Sessions",
  synced: "Last synced",
}

const SortableHeader = ({
  column,
  state,
  onSort,
}: {
  readonly column: Column
  readonly state: TableState
  readonly onSort: (column: Column) => void
}) => (
  <th
    className="border border-rule px-2 py-1 text-left font-semibold"
    aria-sort={state.column === column ? ARIA_SORT[state.direction] : "none"}
  >
    <button type="button" onClick={() => onSort(column)} className="hover:underline">
      {COLUMN_LABEL[column]}
    </button>
  </th>
)

const SyncStatusTable = ({
  rows,
  state,
  onSort,
}: {
  readonly rows: ReadonlyArray<SyncStatusRow>
  readonly state: TableState
  readonly onSort: (column: Column) => void
}) => (
  <div className="mt-4 overflow-x-auto">
    <table className="w-full border-collapse border border-rule text-[0.8125rem]">
      <thead>
        <tr className="bg-panel-2">
          {COLUMNS.map((column) => (
            <SortableHeader key={column} column={column} state={state} onSort={onSort} />
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={`${row.userId}:${row.projectId ?? "none"}`}>
            <UserCell row={row} />
            <ProjectCell row={row} />
            <td className="border border-rule px-2 py-1 align-top">{row.sessionCount}</td>
            <SyncedCell lastSyncedAt={row.lastSyncedAt} />
          </tr>
        ))}
      </tbody>
    </table>
  </div>
)

const FilterBoxes = ({
  state,
  onFilter,
}: {
  readonly state: TableState
  readonly onFilter: (next: Partial<TableState>) => void
}) => (
  <div className="grid grid-cols-1 gap-3 min-[560px]:grid-cols-2">
    <div className="min-w-0">
      <label className={labelClass} htmlFor="sync-status-user-filter">
        User
      </label>
      <input
        id="sync-status-user-filter"
        className={inputClass}
        value={state.user}
        onChange={(event) => onFilter({ user: event.target.value })}
      />
    </div>
    <div className="min-w-0">
      <label className={labelClass} htmlFor="sync-status-project-filter">
        Project
      </label>
      <input
        id="sync-status-project-filter"
        className={inputClass}
        value={state.project}
        onChange={(event) => onFilter({ project: event.target.value })}
      />
    </div>
  </div>
)

const ResultCount = ({ visible, total }: { readonly visible: number; readonly total: number }) =>
  visible === total ? null : (
    <p className="mt-2 font-mono text-[0.72rem] text-ink-soft">
      {visible} of {total} rows
    </p>
  )

export const SyncStatus = () => {
  const [fetchState, setFetchState] = useState<State>({ phase: "loading" })
  const [params, setParams] = useSearchParams()
  const query = params.toString()
  const tableState = useMemo(() => parseState(new URLSearchParams(query)), [query])

  useEffect(() => {
    let active = true

    getJson("/api/sync-status", parseSyncStatusRows).then((result) => {
      if (!active) return
      setFetchState(
        result.ok
          ? { phase: "ready", rows: result.data }
          : { phase: "failed", error: result.error },
      )
    })

    return () => {
      active = false
    }
  }, [])

  const applyState = (next: TableState) => setParams(toParams(next))
  const onSort = (column: Column) =>
    applyState({ ...tableState, column, direction: nextDirection(tableState, column) })
  const onFilter = (next: Partial<TableState>) => applyState({ ...tableState, ...next })
  const clearFilters = () => setParams(new URLSearchParams())

  if (fetchState.phase === "loading") return <LoadingShell label="Retrieving sync status" />
  if (fetchState.phase === "failed") {
    if (fetchState.error.kind === "unauthorized") return <SessionExpired />
    return <ErrorState error={fetchState.error} />
  }
  if (fetchState.rows.length === 0) return <EmptyState />

  const visible = sortRows(filterRows(fetchState.rows, tableState), tableState)
  const filtered = tableState.user !== "" || tableState.project !== ""

  return (
    <section>
      <h1 className="text-[1.375rem] font-semibold leading-tight">Sync status</h1>
      <div className="mt-4">
        <FilterBoxes state={tableState} onFilter={onFilter} />
      </div>
      {filtered ? <ResultCount visible={visible.length} total={fetchState.rows.length} /> : null}
      {visible.length === 0 ? (
        <div className="mt-4">
          <NoMatches state={tableState} onClear={clearFilters} />
        </div>
      ) : (
        <SyncStatusTable rows={visible} state={tableState} onSort={onSort} />
      )}
    </section>
  )
}
