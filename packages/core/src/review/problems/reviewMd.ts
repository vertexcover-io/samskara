import {
  REVIEW_FRICTIONS,
  REVIEW_OUTCOMES,
  type ReviewFriction,
  type ReviewOutcome,
} from "../events.js"
import type { SessionExportRecord } from "../lenses/export.js"

export const PROBLEM_CLASSES = ["missed", "blocked", "slow", "caught"] as const
export const PROBLEM_SEVERITIES = ["high", "medium", "low"] as const
/** Where the fix goes. `human` means the person, not the system, should change. */
export const FIX_TYPES = ["skill", "code", "project_guidelines", "knowledge_base", "human"] as const

/**
 * The fence around the reviewer's output, the same idea as the lens schema's caps. A problem
 * with a field over its limit is dropped; problems past the count are dropped; a summary over
 * its limit is cut short, since losing it would lose the whole review. Characters, except
 * the counts.
 */
export const LIMITS = {
  title: 120,
  summary: 600,
  description: 600,
  learning: 300,
  severityReason: 200,
  quote: 300,
  why: 300,
  extraValue: 200,
  problems: 100,
  evidencePerProblem: 20,
  /** The widest range one Evidence line may cite, in messages. */
  evidenceRange: 50,
  /** The shortest quote that can prove anything, once spaces and quote marks are gone. */
  quoteMin: 2,
} as const

export type Evidence = {
  readonly from: string
  readonly to: string
  readonly quote: string
  /** Why the quote proves the problem, for example "this is wrong: no test ran before it". */
  readonly why: string
}

/** The ids an evidence line or lead cites: `msg-4`, or `msg-4 to msg-9`. */
export const idsLabel = (item: Pick<Evidence, "from" | "to">): string =>
  item.from === item.to ? item.from : `${item.from} to ${item.to}`

export type Problem = {
  readonly title: string
  readonly class: (typeof PROBLEM_CLASSES)[number]
  readonly severity: (typeof PROBLEM_SEVERITIES)[number]
  readonly severityReason: string
  readonly fixType: (typeof FIX_TYPES)[number]
  /** What was expected, and what happened instead. */
  readonly description: string
  readonly evidence: ReadonlyArray<Evidence>
  /** What should change so it does not happen again. */
  readonly learning: string
  readonly extra: Readonly<Record<string, string>>
}

export type ProblemReview = {
  readonly outcome: ReviewOutcome
  readonly friction: ReviewFriction
  readonly summary: string
  readonly problems: ReadonlyArray<Problem>
}

/**
 * `ok` with the problems that passed and the reasons each other one was dropped, or not `ok`
 * when the review as a whole is unusable (no header, no summary, no problems section).
 */
export type ParseResult =
  | { readonly ok: true; readonly value: ProblemReview; readonly dropped: ReadonlyArray<string> }
  | { readonly ok: false; readonly errors: ReadonlyArray<string> }

/** `- **Name:** value`, the one line shape every field in review.md uses. */
const FIELD_RE = /^-\s+\*\*([^*]+?):\*\*\s*(.*)$/

/**
 * `msg-1 to msg-2 — "quote" — why`. The range may also be written `msg-1–msg-2`, and the quote
 * marks may be straight or curly.
 */
const EVIDENCE_RE =
  /^(msg-\d+)(?:\s*(?:to|[—–-])\s*(msg-\d+))?\s*[—–-]\s*["“](.+?)["”]\s*[—–-]\s*(.+)$/

/** The ids at the start of an evidence line: `msg-4`, `msg-4 to msg-9`, `msg-4–msg-9`. */
const IDS_RE = /^(msg-\d+)(?:\s*(?:to|[—–-])\s*(msg-\d+))?$/

/**
 * One evidence line into its parts. Split on the em or en dash separators first, so a quote
 * that has quote marks of its own (`"over":157`) survives; the outer quote marks, when
 * present, are removed. Falls back to the stricter pattern for lines separated by hyphens.
 */
export const parseEvidenceLine = (line: string): Evidence | undefined => {
  const parts = line.trim().split(/\s+[—–]\s+/)
  if (parts.length >= 3) {
    const ids = IDS_RE.exec(parts[0]?.trim() ?? "")
    const why = parts.at(-1)?.trim() ?? ""
    let quote = parts.slice(1, -1).join(" — ").trim()
    if (/^["“][\s\S]*["”]$/.test(quote) && quote.length >= 2) quote = quote.slice(1, -1)
    if (ids !== null && quote !== "" && why !== "") {
      const from = ids[1] ?? ""
      return { from, to: ids[2] ?? from, quote, why }
    }
  }
  const match = EVIDENCE_RE.exec(line.trim())
  if (match === null) return undefined
  const from = match[1] ?? ""
  return { from, to: match[2] ?? from, quote: match[3] ?? "", why: match[4]?.trim() ?? "" }
}

/** Every `- **Name:** value` field; a text line straight after one continues its value. */
const fieldsOf = (lines: ReadonlyArray<string>): Array<[string, string]> => {
  const fields: Array<[string, string]> = []
  let open = false
  // The field an indented list belongs to: `- **Evidence:**` followed by `  - msg-…` items.
  let listKey: string | undefined
  for (const line of lines) {
    const text = line.trim()
    const match = FIELD_RE.exec(text)
    const item = /^\s+[-*]\s+(.+)$/.exec(line)
    const last = fields.at(-1)
    if (match !== null) {
      listKey = match[1]?.trim().toLowerCase() ?? ""
      fields.push([listKey, match[2]?.trim() ?? ""])
      open = true
    } else if (item !== null && listKey !== undefined) {
      // Each listed item is its own value of that field, never part of the one before it.
      fields.push([listKey, item[1]?.trim() ?? ""])
      open = true
    } else if (open && last !== undefined && text !== "" && !/^#{1,6}\s/.test(text)) {
      last[1] = `${last[1]} ${text}`
    } else open = false
  }
  return fields
}

/** Every `### title` block and the lines under it, up to the next one. */
const blocksOf = (lines: ReadonlyArray<string>): Array<{ title: string; body: string[] }> => {
  const blocks: Array<{ title: string; body: string[] }> = []
  for (const line of lines) {
    const heading = /^###\s+(.+)$/.exec(line.trim())
    if (heading !== null) blocks.push({ title: heading[1]?.trim() ?? "", body: [] })
    else blocks.at(-1)?.body.push(line)
  }
  return blocks
}

/** A section's body: every line after `## name` up to the next `## ` heading. */
export const section = (lines: ReadonlyArray<string>, name: string): string[] | undefined => {
  const start = lines.findIndex((line) => line.trim().toLowerCase() === `## ${name}`)
  if (start === -1) return undefined
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((line) => /^##\s/.test(line))
  return end === -1 ? rest : rest.slice(0, end)
}

const capitalized = (name: string): string => `${name.charAt(0).toUpperCase()}${name.slice(1)}`

const oneOf = <T extends string>(
  allowed: ReadonlyArray<T>,
  value: string,
  label: string,
  errors: string[],
  where: string,
): T | undefined => {
  const word = value.trim().toLowerCase()
  if ((allowed as ReadonlyArray<string>).includes(word)) return word as T
  errors.push(`${where}${label} must be one of ${allowed.join(", ")}, not "${value}"`)
  return undefined
}

const withinLimit = (
  value: string,
  limit: number,
  label: string,
  errors: string[],
  where: string,
): void => {
  if (value.length > limit) errors.push(`${where}${label} is longer than ${limit} characters`)
}

/**
 * `stage: coder; tool: bash` into `{ stage: "coder", tool: "bash" }`; names are lowercased. A
 * piece with no colon after a named one is part of that value — a value may hold a `;`.
 */
const extraOf = (value: string, errors: string[], where: string): Record<string, string> => {
  const extra: Record<string, string> = {}
  let lastKey: string | undefined
  for (const pair of value.split(";")) {
    if (pair.trim() === "") continue
    const colon = pair.indexOf(":")
    if (colon === -1) {
      if (lastKey !== undefined) extra[lastKey] = `${extra[lastKey]}; ${pair.trim()}`
      else errors.push(`${where}Extra must read name: value, not "${pair.trim()}"`)
      continue
    }
    const key = pair.slice(0, colon).trim().toLowerCase()
    if (key === "") continue
    extra[key] = pair.slice(colon + 1).trim()
    lastKey = key
  }
  for (const [key, entry] of Object.entries(extra))
    withinLimit(entry, LIMITS.extraValue, `Extra "${key}"`, errors, where)
  return extra
}

/** One problem, or the reasons it cannot be kept. */
const parseProblem = (
  title: string,
  body: ReadonlyArray<string>,
): { problem?: Problem; errors: string[] } => {
  const errors: string[] = []
  const where = `"${title}": `
  withinLimit(title, LIMITS.title, "Title", errors, where)
  const fields = fieldsOf(body)
  const one = (name: string): string | undefined => {
    const found = fields.find(([key]) => key === name)?.[1]
    if (found === undefined || found === "") {
      errors.push(`${where}missing ${capitalized(name)}`)
      return undefined
    }
    return found
  }

  const classRaw = one("class")
  const severityRaw = one("severity")
  const fixTypeRaw = one("fix type")
  const description = one("description")
  const learning = one("learning")
  if (description !== undefined)
    withinLimit(description, LIMITS.description, "Description", errors, where)
  if (learning !== undefined) withinLimit(learning, LIMITS.learning, "Learning", errors, where)

  // One line or a heading with the messages listed under it; the heading itself is empty.
  const evidenceLines = fields
    .filter(([key, value]) => key === "evidence" && value !== "")
    .map(([, value]) => value)
  if (evidenceLines.length === 0) errors.push(`${where}no Evidence`)
  if (evidenceLines.length > LIMITS.evidencePerProblem)
    errors.push(`${where}more than ${LIMITS.evidencePerProblem} Evidence lines`)
  const evidence: Evidence[] = []
  for (const line of evidenceLines) {
    const parsed = parseEvidenceLine(line)
    if (parsed === undefined) {
      errors.push(`${where}Evidence must read msg-N to msg-M — "quote" — why, not ${line}`)
      continue
    }
    withinLimit(parsed.quote, LIMITS.quote, "Evidence quote", errors, where)
    withinLimit(parsed.why, LIMITS.why, "Evidence reason", errors, where)
    evidence.push(parsed)
  }

  const cls =
    classRaw === undefined ? undefined : oneOf(PROBLEM_CLASSES, classRaw, "Class", errors, where)
  const fixType =
    fixTypeRaw === undefined ? undefined : oneOf(FIX_TYPES, fixTypeRaw, "Fix type", errors, where)
  let severity: Problem["severity"] | undefined
  let severityReason = ""
  if (severityRaw !== undefined) {
    const [word = "", ...reason] = severityRaw.split(/\s+[—–-]\s+/)
    severity = oneOf(PROBLEM_SEVERITIES, word, "Severity", errors, where)
    severityReason = reason.join(" — ").trim()
    if (severityReason === "") errors.push(`${where}Severity needs a reason after the word`)
    withinLimit(severityReason, LIMITS.severityReason, "Severity reason", errors, where)
  }
  const extra = extraOf(fields.find(([key]) => key === "extra")?.[1] ?? "", errors, where)

  if (
    errors.length > 0 ||
    cls === undefined ||
    severity === undefined ||
    fixType === undefined ||
    description === undefined ||
    learning === undefined
  )
    return { errors }
  return {
    problem: {
      title,
      class: cls,
      severity,
      severityReason,
      fixType,
      description,
      evidence,
      learning,
      extra,
    },
    errors,
  }
}

/**
 * Reads the review.md a reviewer wrote. Markdown for people to read, but every field has a
 * fixed name, a fixed set of words and a length limit, so code can read and fence it. A
 * broken problem is dropped with its reasons and the rest is kept — the same rule the lens
 * parser follows for a broken entry. Only a review with no usable header fails whole.
 */
export const parseReviewMd = (markdown: string): ParseResult => {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n")
  const errors: string[] = []

  const firstSection = lines.findIndex((line) => /^##\s/.test(line))
  const header = fieldsOf(firstSection === -1 ? lines : lines.slice(0, firstSection))
  const headerField = (name: string): string => header.find(([key]) => key === name)?.[1] ?? ""
  const outcome = oneOf(REVIEW_OUTCOMES, headerField("outcome"), "Outcome", errors, "")
  const friction = oneOf(REVIEW_FRICTIONS, headerField("friction"), "Friction", errors, "")

  const fullSummary = section(lines, "summary")?.join("\n").trim() ?? ""
  if (fullSummary === "") errors.push("missing ## Summary")
  const summary = fullSummary.slice(0, LIMITS.summary)

  const problemLines = section(lines, "problems")
  if (problemLines === undefined) errors.push("missing ## Problems")
  if (errors.length > 0 || outcome === undefined || friction === undefined || !problemLines)
    return { ok: false, errors }

  const blocks = blocksOf(problemLines)

  const problems: Problem[] = []
  const dropped: string[] = []
  if (fullSummary.length > LIMITS.summary)
    dropped.push(`Summary cut to ${LIMITS.summary} characters`)
  for (const block of blocks.slice(0, LIMITS.problems)) {
    const result = parseProblem(block.title, block.body)
    if (result.problem !== undefined) problems.push(result.problem)
    else dropped.push(...result.errors)
  }
  if (blocks.length > LIMITS.problems)
    dropped.push(`${blocks.length - LIMITS.problems} problems past the limit of ${LIMITS.problems}`)

  return { ok: true, value: { outcome, friction, summary, problems }, dropped }
}

const JSON_ESCAPES: Readonly<Record<string, string>> = { n: " ", r: " ", t: " " }

/**
 * Text as a quote is compared: JSON escapes undone (a reviewer copying from session.json sees
 * \\" and \\n), quote marks dropped, whitespace and case ignored.
 */
const squash = (text: string): string =>
  text
    .replace(/\\(["\\/nrt])/g, (_, char: string) => JSON_ESCAPES[char] ?? char)
    .replace(/["“”]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()

/** Everything a record says, as one searchable string. */
const recordText = (record: SessionExportRecord): string =>
  [record.text, record.toolName, record.input, record.output].filter(Boolean).join(" ")

/**
 * A checker for quotes against one session: both ids exist, the range runs forward and is
 * not too wide, and the quote is really there (it may skip words with `…`). Returns why a
 * quote fails, or undefined when it holds. Built once per session — it squashes every record
 * up front, since a review can cite the same stretch many times.
 */
export const quoteChecker = (
  records: ReadonlyArray<SessionExportRecord>,
  /** The widest range a quote may cite; leads pass Infinity, since they only point the way. */
  maxRange: number = LIMITS.evidenceRange,
): ((item: Pick<Evidence, "from" | "to" | "quote">) => string | undefined) => {
  const seqById = new Map(records.map((record) => [record.id, record.seq]))
  const squashed = records.map((record) => squash(recordText(record)))
  return (item) => {
    const ids = idsLabel(item)
    const from = seqById.get(item.from)
    const to = seqById.get(item.to)
    if (from === undefined || to === undefined) return `${ids}: no such message`
    if (to < from) return `${ids}: range runs backwards`
    if (to - from + 1 > maxRange) return `${ids}: range is wider than ${maxRange} messages`
    const pieces = item.quote
      .split(/…|\.\.\./)
      .map(squash)
      .filter((piece) => piece !== "")
    if (pieces.join("").length < LIMITS.quoteMin)
      return `${ids}: the quote is too short to prove anything`
    const haystack = squashed.slice(from, to + 1).join(" ")
    return pieces.every((piece) => haystack.includes(piece))
      ? undefined
      : `"${item.quote}" is not in ${ids}`
  }
}

/**
 * Checks every piece of evidence against the session: both ids exist, the range runs
 * forward, and the quote is really there (a quote may skip words with `…`). A problem with
 * any evidence that fails is dropped, with the reason — it is not proof if it is not there.
 */
export const checkEvidence = (
  review: ProblemReview,
  records: ReadonlyArray<SessionExportRecord>,
): { review: ProblemReview; dropped: string[] } => {
  const check = quoteChecker(records)
  const dropped: string[] = []
  const problems = review.problems.filter((problem) => {
    const failures = problem.evidence.flatMap((item) => {
      const error = check(item)
      return error === undefined ? [] : [`"${problem.title}": ${error}`]
    })
    dropped.push(...failures)
    return failures.length === 0
  })
  return { review: { ...review, problems }, dropped }
}
