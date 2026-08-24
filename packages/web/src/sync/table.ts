import type { SyncStatusRow } from "../api/types.js"

export const COLUMNS = ["user", "project", "sessions", "synced"] as const

export type Column = (typeof COLUMNS)[number]

export type Direction = "asc" | "desc"

export type TableState = {
  readonly column: Column
  readonly direction: Direction
  readonly user: string
  readonly project: string
}

export const DEFAULT_STATE: TableState = {
  column: "synced",
  direction: "desc",
  user: "",
  project: "",
}

const isColumn = (value: string | null): value is Column =>
  value !== null && COLUMNS.some((column) => column === value)

const isDirection = (value: string | null): value is Direction =>
  value === "asc" || value === "desc"

export const parseState = (params: URLSearchParams): TableState => {
  const sort = params.get("sort")
  const dir = params.get("dir")
  return {
    column: isColumn(sort) ? sort : DEFAULT_STATE.column,
    direction: isDirection(dir) ? dir : DEFAULT_STATE.direction,
    user: params.get("user") ?? DEFAULT_STATE.user,
    project: params.get("project") ?? DEFAULT_STATE.project,
  }
}

export const toParams = (state: TableState): URLSearchParams => {
  const params = new URLSearchParams()
  if (state.column !== DEFAULT_STATE.column) params.set("sort", state.column)
  if (state.direction !== DEFAULT_STATE.direction) params.set("dir", state.direction)
  if (state.user !== DEFAULT_STATE.user) params.set("user", state.user)
  if (state.project !== DEFAULT_STATE.project) params.set("project", state.project)
  return params
}

export const nextDirection = (state: TableState, column: Column): Direction =>
  state.column === column && state.direction === "desc" ? "asc" : "desc"

const matchesUser = (row: SyncStatusRow, term: string): boolean =>
  row.githubLogin.toLowerCase().includes(term) || (row.name?.toLowerCase().includes(term) ?? false)

const matchesProject = (row: SyncStatusRow, term: string): boolean => {
  if (row.projectName === null) return term === ""
  return (
    row.projectName.toLowerCase().includes(term) ||
    (row.projectSlug?.toLowerCase().includes(term) ?? false)
  )
}

export const filterRows = (
  rows: ReadonlyArray<SyncStatusRow>,
  state: TableState,
): ReadonlyArray<SyncStatusRow> => {
  const user = state.user.toLowerCase()
  const project = state.project.toLowerCase()
  return rows.filter((row) => matchesUser(row, user) && matchesProject(row, project))
}

type RowComparator = (a: SyncStatusRow, b: SyncStatusRow, sign: number) => number

// Nulls are ranked before the directional compare runs, and that rank is never multiplied by
// `sign` — otherwise ascending order would carry never-synced rows to the top instead of the
// bottom, hiding the exact rows this table exists to surface.
const compareBy =
  <T>(pick: (row: SyncStatusRow) => T | null, compare: (a: T, b: T) => number): RowComparator =>
  (a, b, sign) => {
    const valueA = pick(a)
    const valueB = pick(b)
    if (valueA === null || valueB === null) {
      return (valueA === null ? 1 : 0) - (valueB === null ? 1 : 0)
    }
    return sign * compare(valueA, valueB)
  }

const compareStrings = (a: string, b: string): number => a.localeCompare(b)

const COMPARATORS: Readonly<Record<Column, RowComparator>> = {
  user: compareBy((row) => row.githubLogin, compareStrings),
  project: compareBy((row) => row.projectName, compareStrings),
  sessions: compareBy(
    (row) => row.sessionCount,
    (a, b) => a - b,
  ),
  synced: compareBy((row) => row.lastSyncedAt, compareStrings),
}

export const sortRows = (
  rows: ReadonlyArray<SyncStatusRow>,
  state: TableState,
): ReadonlyArray<SyncStatusRow> => {
  const compare = COMPARATORS[state.column]
  const sign = state.direction === "asc" ? 1 : -1
  return [...rows].sort((a, b) => compare(a, b, sign))
}
