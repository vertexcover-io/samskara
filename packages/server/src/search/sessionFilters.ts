import { z } from "zod"
import { parseSessionQuery, type SessionQuery } from "./sessionQuery.js"

export const SESSION_SORTS = ["recent", "oldest", "tokens", "project", "relevance"] as const
export const SESSION_RANGES = ["all", "hour", "today", "week", "month", "custom"] as const
export const AI_REVIEW_FILTERS = ["done", "missing"] as const

const validIsoDate = (value: string): boolean => {
  const [year, month, day] = value.split("-").map(Number)
  if (year === undefined || month === undefined || day === undefined) return false
  const date = new Date(0)
  date.setUTCFullYear(year, month - 1, day)
  date.setUTCHours(0, 0, 0, 0)
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month && date.getUTCDate() === day
  )
}

const isoDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(validIsoDate, "Invalid calendar date")
  .optional()

const unicodeLength = (value: string): number => Array.from(value).length
const nonEmptyUnicode = (max: number) =>
  z
    .string()
    .trim()
    .refine((value) => unicodeLength(value) >= 1 && unicodeLength(value) <= max)

const canonicalPr = z
  .string()
  .trim()
  .regex(/^[1-9][0-9]{0,9}$/)
  .refine((value) => Number(value) <= 2_147_483_647)
  .transform(Number)

const canonicalCommit = z
  .string()
  .trim()
  .regex(/^[0-9a-fA-F]{7,40}$/)
  .transform((value) => value.toLowerCase())

const validTimeZone = (value: string): boolean => {
  try {
    Intl.DateTimeFormat("en-US", { timeZone: value })
    return true
  } catch {
    return false
  }
}

export const sessionListQuerySchema = z.object({
  q: nonEmptyUnicode(200).optional(),
  project: z.string().uuid().optional(),
  user: nonEmptyUnicode(255).optional(),
  repo: z
    .string()
    .trim()
    .regex(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/)
    .optional(),
  branch: nonEmptyUnicode(255).optional(),
  pr: canonicalPr.optional(),
  commit: canonicalCommit.optional(),
  aiReview: z.enum(AI_REVIEW_FILTERS).optional(),
  range: z.enum(SESSION_RANGES).optional(),
  from: isoDate,
  to: isoDate,
  sort: z.enum(SESSION_SORTS).optional(),
  page: z.coerce.number().int().min(1).max(100_000).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  tz: z.string().trim().refine(validTimeZone, "Invalid IANA time zone").optional(),
})

export type SessionListQuery = z.infer<typeof sessionListQuerySchema> & {
  readonly parsedQuery?: SessionQuery
}

export type SessionPagination = {
  readonly page: number
  readonly limit: number
  readonly total: number
  readonly totalPages: number
}

export const paginate = (total: number, page: number, limit: number): SessionPagination => ({
  page,
  limit,
  total,
  totalPages: Math.ceil(total / limit),
})

export const parseSessionListQuery = (value: unknown): SessionListQuery => {
  const parsed = sessionListQuerySchema.parse(value)
  return parsed.q === undefined ? parsed : { ...parsed, parsedQuery: parseSessionQuery(parsed.q) }
}

type LocalDate = { readonly year: number; readonly month: number; readonly day: number }

const parseLocalDate = (value: string): LocalDate => {
  const [year, month, day] = value.split("-").map(Number)
  if (year === undefined || month === undefined || day === undefined)
    throw new Error("Invalid date")
  return { year, month, day }
}

const dateParts = (
  value: Date,
  timeZone: string,
): LocalDate & { readonly hour: number; readonly minute: number } => {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  })
  const parts = Object.fromEntries(
    formatter
      .formatToParts(value)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  )
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  }
}

/** Converts a local calendar midnight to UTC without treating dates as UTC calendar dates. */
export const localMidnight = (date: LocalDate, timeZone: string): Date => {
  const wanted = Date.UTC(date.year, date.month - 1, date.day)
  let candidate = wanted
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const actual = dateParts(new Date(candidate), timeZone)
    const observed = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute)
    const next = wanted - (observed - candidate)
    if (next === candidate) return new Date(candidate)
    candidate = next
  }
  return new Date(candidate)
}

const addLocalDays = (date: LocalDate, days: number): LocalDate => {
  const next = new Date(Date.UTC(date.year, date.month - 1, date.day + days))
  return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() }
}

const localToday = (now: Date, timeZone: string): LocalDate => {
  const { year, month, day } = dateParts(now, timeZone)
  return { year, month, day }
}

export type SessionDateWindow = {
  readonly since?: Date
  /** Exclusive upper bound. The current repository uses an inclusive predicate until its search refactor. */
  readonly until?: Date
}

export const dateWindowFor = (query: SessionListQuery, now: Date): SessionDateWindow => {
  const timeZone = query.tz ?? "UTC"
  if (query.range === "hour") return { since: new Date(now.getTime() - 60 * 60 * 1000) }
  if (query.range === "week") return { since: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000) }
  if (query.range === "month") return { since: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000) }
  if (query.range === "today") return { since: localMidnight(localToday(now, timeZone), timeZone) }
  if (query.range !== "custom") return {}

  return {
    since:
      query.from === undefined ? undefined : localMidnight(parseLocalDate(query.from), timeZone),
    until:
      query.to === undefined
        ? undefined
        : localMidnight(addLocalDays(parseLocalDate(query.to), 1), timeZone),
  }
}
