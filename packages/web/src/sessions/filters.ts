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

export const SORTS = ["relevance", "recent", "oldest", "tokens", "project"] as const

export type Sort = (typeof SORTS)[number]

export const SORT_LABEL: Readonly<Record<Sort, string>> = {
  relevance: "Relevance",
  recent: "Most recent",
  oldest: "Oldest first",
  tokens: "Most tokens",
  project: "Project name",
}

export const AI_REVIEW_STATES = ["done", "missing"] as const

export type AiReviewState = (typeof AI_REVIEW_STATES)[number]

export type SessionFilters = {
  readonly q: string | null
  readonly project: string | null
  readonly user: string | null
  readonly repo: string | null
  readonly branch: string | null
  readonly pr: string | null
  readonly commit: string | null
  readonly aiReview: AiReviewState | null
  readonly range: Range
  readonly from: string | null
  readonly to: string | null
  readonly tz: string | null
  readonly sort: Sort
  readonly page: number
}

export const EMPTY_FILTERS: SessionFilters = {
  q: null,
  project: null,
  user: null,
  repo: null,
  branch: null,
  pr: null,
  commit: null,
  aiReview: null,
  range: "all",
  from: null,
  to: null,
  tz: null,
  sort: "recent",
  page: 1,
}

const isRange = (value: string | null): value is Range =>
  value !== null && RANGES.some((range) => range === value)

const isSort = (value: string | null): value is Sort =>
  value !== null && SORTS.some((sort) => sort === value)

const isAiReviewState = (value: string | null): value is AiReviewState =>
  value !== null && AI_REVIEW_STATES.some((state) => state === value)

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

const pageNumber = (value: string | null): number => {
  if (value === null || !/^[1-9][0-9]*$/.test(value)) return 1
  const page = Number(value)
  return Number.isSafeInteger(page) ? page : 1
}

/**
 * Keep invalid user input in the URL. The API owns validation and must be able to explain a bad
 * PR number, commit prefix, or branch instead of the client silently broadening the search.
 */
const rawValue = (value: string | null): string | null => (value === "" ? null : value)

const commitValue = (value: string | null): string | null => {
  const text = rawValue(value)
  return text === null ? null : text.trim().toLowerCase()
}

export const localTimeZone = (): string | null => {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
  return zone === undefined || zone === "" ? null : zone
}

export const parseFilters = (params: URLSearchParams): SessionFilters => {
  const q = trimmed(params.get("q"))
  const sort = params.get("sort")
  return {
    q,
    project: trimmed(params.get("project")),
    user: trimmed(params.get("user")),
    repo: rawValue(params.get("repo")),
    branch: rawValue(params.get("branch")),
    pr: rawValue(params.get("pr")),
    commit: commitValue(params.get("commit")),
    aiReview: isAiReviewState(params.get("aiReview"))
      ? (params.get("aiReview") as AiReviewState)
      : null,
    range: isRange(params.get("range")) ? (params.get("range") as Range) : "all",
    from: isoDate(params.get("from")),
    to: isoDate(params.get("to")),
    tz: trimmed(params.get("tz")),
    sort: isSort(sort) ? sort : q === null ? "recent" : "relevance",
    page: pageNumber(params.get("page")),
  }
}

// `searchQuery` in packages/cli/src/commands/search.ts hand-mirrors this function so the CLI and
// the UI build the same query string. Change one, change both.
export const serializeFilters = (filters: SessionFilters): URLSearchParams => {
  const params = new URLSearchParams()
  if (filters.q !== null) params.set("q", filters.q)
  if (filters.project !== null) params.set("project", filters.project)
  if (filters.user !== null) params.set("user", filters.user)
  if (filters.repo !== null) params.set("repo", filters.repo)
  if (filters.branch !== null) params.set("branch", filters.branch)
  if (filters.pr !== null) params.set("pr", filters.pr)
  if (filters.commit !== null) params.set("commit", filters.commit.toLowerCase())
  if (filters.aiReview !== null) params.set("aiReview", filters.aiReview)
  if (filters.range !== "all") params.set("range", filters.range)
  if (filters.range === "custom") {
    if (filters.from !== null) params.set("from", filters.from)
    if (filters.to !== null) params.set("to", filters.to)
  }
  if ((filters.range === "today" || filters.range === "custom") && filters.tz !== null) {
    params.set("tz", filters.tz)
  }
  if (filters.sort !== "recent") params.set("sort", filters.sort)
  if (filters.page > 1) params.set("page", String(filters.page))
  return params
}

/** Result-affecting controls always return to the first page. */
export const changedFilters = (
  filters: SessionFilters,
  change: Partial<SessionFilters>,
): SessionFilters => {
  const next = { ...filters, ...change, page: 1 }
  if (next.q === null && next.sort === "relevance") return { ...next, sort: "recent" }
  return next
}

export const clearFilter = <K extends keyof SessionFilters>(
  filters: SessionFilters,
  key: K,
): SessionFilters => {
  const defaults: Pick<
    SessionFilters,
    "q" | "project" | "user" | "repo" | "branch" | "pr" | "commit"
  > = {
    q: null,
    project: null,
    user: null,
    repo: null,
    branch: null,
    pr: null,
    commit: null,
  }
  if (!(key in defaults))
    return changedFilters(filters, { [key]: EMPTY_FILTERS[key] } as Partial<SessionFilters>)
  return changedFilters(filters, {
    [key]: defaults[key as keyof typeof defaults],
  } as Partial<SessionFilters>)
}
