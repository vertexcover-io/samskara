export const RANGES = ["all", "hour", "today", "week", "month", "custom"] as const

export type Range = (typeof RANGES)[number]

export const RANGE_LABEL: Readonly<Record<Range, string>> = {
  all: "Any time",
  hour: "Past hour",
  today: "Today",
  week: "Past 7 days",
  month: "Past 30 days",
  custom: "Custom range…",
}

export const SORTS = ["recent", "oldest", "tokens", "project"] as const

export type Sort = (typeof SORTS)[number]

export const SORT_LABEL: Readonly<Record<Sort, string>> = {
  recent: "Most recent",
  oldest: "Oldest first",
  tokens: "Most tokens",
  project: "Project name",
}

export type SessionFilters = {
  readonly project: string | null
  readonly user: string | null
  readonly range: Range
  readonly from: string | null
  readonly to: string | null
  readonly sort: Sort
}

export const EMPTY_FILTERS: SessionFilters = {
  project: null,
  user: null,
  range: "all",
  from: null,
  to: null,
  sort: "recent",
}

const isRange = (value: string | null): value is Range =>
  value !== null && RANGES.some((range) => range === value)

const isSort = (value: string | null): value is Sort =>
  value !== null && SORTS.some((sort) => sort === value)

const trimmed = (value: string | null): string | null => {
  if (value === null) return null
  const text = value.trim()
  return text === "" ? null : text
}

const isoDate = (value: string | null): string | null => {
  const text = trimmed(value)
  if (text === null) return null
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null
}

export const parseFilters = (params: URLSearchParams): SessionFilters => {
  const range = params.get("range")
  const sort = params.get("sort")
  return {
    project: trimmed(params.get("project")),
    user: trimmed(params.get("user")),
    range: isRange(range) ? range : "all",
    from: isoDate(params.get("from")),
    to: isoDate(params.get("to")),
    sort: isSort(sort) ? sort : "recent",
  }
}

export const serializeFilters = (filters: SessionFilters): URLSearchParams => {
  const params = new URLSearchParams()
  if (filters.project !== null) params.set("project", filters.project)
  if (filters.user !== null) params.set("user", filters.user)
  if (filters.range !== "all") params.set("range", filters.range)
  if (filters.range === "custom") {
    if (filters.from !== null) params.set("from", filters.from)
    if (filters.to !== null) params.set("to", filters.to)
  }
  if (filters.sort !== "recent") params.set("sort", filters.sort)
  return params
}

const startOf = (range: Range, now: number): number | null => {
  if (range === "hour") return now - 3_600_000
  if (range === "today") {
    const start = new Date(now)
    start.setHours(0, 0, 0, 0)
    return start.getTime()
  }
  if (range === "week") return now - 7 * 86_400_000
  if (range === "month") return now - 30 * 86_400_000
  return null
}

type Sortable = {
  readonly lastActiveAt: string
  readonly tokensTotal: number
  readonly projectName: string
}

export const withinRange = (
  filters: SessionFilters,
  lastActiveAt: string,
  now: number = Date.now(),
): boolean => {
  const at = new Date(lastActiveAt).getTime()
  if (Number.isNaN(at)) return true

  if (filters.range === "custom") {
    if (filters.from !== null && at < new Date(`${filters.from}T00:00:00`).getTime()) return false
    if (filters.to !== null && at > new Date(`${filters.to}T23:59:59.999`).getTime()) return false
    return true
  }

  const start = startOf(filters.range, now)
  return start === null || at >= start
}

export const sortSessions = <T extends Sortable>(
  sessions: ReadonlyArray<T>,
  sort: Sort,
): ReadonlyArray<T> => {
  const at = (session: T): number => new Date(session.lastActiveAt).getTime() || 0
  const copy = [...sessions]

  if (sort === "oldest") return copy.sort((a, b) => at(a) - at(b))
  if (sort === "tokens") return copy.sort((a, b) => b.tokensTotal - a.tokensTotal)
  if (sort === "project") {
    return copy.sort((a, b) => a.projectName.localeCompare(b.projectName) || at(b) - at(a))
  }
  return copy.sort((a, b) => at(b) - at(a))
}
