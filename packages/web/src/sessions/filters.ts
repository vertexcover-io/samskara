export const RANGES = ["all", "today", "week", "month"] as const

export type Range = (typeof RANGES)[number]

export type SessionFilters = {
  readonly project: string | null
  readonly user: string | null
  readonly range: Range
}

export const EMPTY_FILTERS: SessionFilters = { project: null, user: null, range: "all" }

const isRange = (value: string | null): value is Range =>
  value !== null && RANGES.some((range) => range === value)

const trimmed = (value: string | null): string | null => {
  if (value === null) return null
  const text = value.trim()
  return text === "" ? null : text
}

export const parseFilters = (params: URLSearchParams): SessionFilters => {
  const range = params.get("range")
  return {
    project: trimmed(params.get("project")),
    user: trimmed(params.get("user")),
    range: isRange(range) ? range : "all",
  }
}

export const serializeFilters = (filters: SessionFilters): URLSearchParams => {
  const params = new URLSearchParams()
  if (filters.project !== null) params.set("project", filters.project)
  if (filters.user !== null) params.set("user", filters.user)
  if (filters.range !== "all") params.set("range", filters.range)
  return params
}
