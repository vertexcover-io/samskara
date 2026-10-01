import { open } from "node:fs/promises"
import { join } from "node:path"
import type { SessionExport, SessionExportRecord } from "../lenses/export.js"
import type { HarnessRunInput, HarnessRunner } from "../runner.js"
import {
  assembleReviewContract,
  buildProblemReviewPrompt,
  reviewMdSkeleton,
  sessionJsonText,
} from "./contract.js"
import { type FoundLeads, findAgentLeads } from "./finder.js"
import { findLeads, HUMAN_SECTION, type Leads } from "./leads.js"
import {
  checkEvidence,
  type ProblemReview,
  parseEvidenceLine,
  parseReviewMd,
  quoteChecker,
  section,
} from "./reviewMd.js"
import { readOr } from "./workspace.js"

/** The reviewer chose this file's size, so it is capped; 100 full problems fit well under it. */
export const MAX_REVIEW_MD_BYTES = 1024 * 1024

/**
 * A script the reviewer runs before it finishes: it lists every lead id in leads.md that
 * leads-answered.md has not answered, and every person's message dropped without quoting that
 * message. Plain node, no dependencies — the workspace has node and nothing else.
 * Must check answers the same way as `answersOf` and `answerHolds`, which check them again
 * after the run (they also undo JSON escapes and need a quote of at least two characters).
 */
const LEAD_CHECK_SCRIPT = `import { readFileSync } from "node:fs"
const leadsMd = readFileSync("leads.md", "utf8")
const leads = [...leadsMd.matchAll(/^- (L\\d+) /gm)].map((m) => m[1])
const humanPart = leadsMd.split(/^## /m).find((part) => part.startsWith("${HUMAN_SECTION}\\n")) ?? ""
const human = new Map([...humanPart.matchAll(/^- (L\\d+) (msg-\\d+):/gm)].map((m) => [m[1], m[2]]))
const answersMd = readFileSync("leads-answered.md", "utf8")
const answers = new Map([...answersMd.matchAll(/^\\s*-\\s+(L\\d+):\\s*(.*)$/gm)].map((m) => [m[1], m[2]]))
const records = new Map(
  readFileSync("session.json", "utf8")
    .split("\\n")
    .filter((line) => line.startsWith('{"seq"'))
    .map((line) => JSON.parse(line.replace(/,$/, "")))
    .map((record) => [record.id, record]),
)
const squash = (text) => text.replace(/["“”]/g, "").replace(/\\s+/g, " ").trim().toLowerCase()
const quotesOwnMessage = (answer, msgId) => {
  if (/^problem\\b/.test(answer)) return true
  const m = /^dropped\\s+[—–]\\s+(msg-\\d+)\\s+[—–]\\s+["“](.+?)["”]\\s+[—–]\\s+\\S/.exec(answer)
  if (m === null || m[1] !== msgId) return false
  const record = records.get(msgId) ?? {}
  const text = squash([record.text, record.toolName, record.input, record.output].filter(Boolean).join(" "))
  const pieces = m[2].split(/…|\\.\\.\\./).map(squash).filter(Boolean)
  return pieces.length > 0 && pieces.every((piece) => text.includes(piece))
}
const missing = leads.filter((id) => !answers.has(id))
if (missing.length > 0) {
  console.log("Not yet answered in leads-answered.md: " + missing.join(", "))
  process.exit(1)
}
const unquoted = leads.filter((id) => human.has(id) && !quotesOwnMessage(answers.get(id), human.get(id)))
if (unquoted.length > 0) {
  console.log("Human messages dropped without quoting the message itself: " + unquoted.join(", ") + ". Write - " + unquoted[0] + ': dropped — msg-N — "their exact words" — why it is an ordinary answer')
  process.exit(1)
}
console.log("All " + leads.length + " leads accounted for.")
`

/**
 * Each answer in leads-answered.md, by lead id: the text after `- L4:`. Must read answers the
 * same way as `LEAD_CHECK_SCRIPT`.
 */
const answersOf = (answers: string): Map<string, string> =>
  new Map(
    [...answers.matchAll(/^\s*-\s+(L\d+):\s*(.*)$/gm)].map((match) => [
      match[1] as string,
      match[2] as string,
    ]),
  )

/**
 * Whether an answer accounts for its lead. Any answer does, except for the person's own
 * message (`msgId` set): that one is dropped only with a quote of the message itself.
 * Must hold answers to the same rules as `LEAD_CHECK_SCRIPT`.
 */
const answerHolds = (
  answer: string | undefined,
  msgId: string | undefined,
  quote: ReturnType<typeof quoteChecker>,
): boolean => {
  if (answer === undefined) return false
  if (msgId === undefined || /^problem\b/.test(answer)) return true
  const dropped = /^dropped\s+[—–]\s+(.+)$/.exec(answer)?.[1]
  const evidence = dropped === undefined ? undefined : parseEvidenceLine(dropped)
  return (
    evidence !== undefined &&
    evidence.from === msgId &&
    evidence.to === msgId &&
    quote(evidence) === undefined
  )
}

export type PreparedProblems = {
  readonly found: FoundLeads
  /** leads.md: what the readers found, then what code found. The reviewer answers each. */
  readonly leadsMd: string
  readonly leadIds: ReadonlyArray<string>
  readonly humanLeads: Leads["humanLeads"]
}

/**
 * Everything before the review: readers read every piece of the session and find leads, and
 * code adds its own. The reviewer then checks each lead against the session and writes up the
 * real ones.
 */
export const prepareProblems = async (input: {
  readonly exported: SessionExport
  readonly instructions: string
  readonly runner: HarnessRunner
  readonly run?: Pick<HarnessRunInput, "harness" | "model">
}): Promise<PreparedProblems> => {
  const found = await findAgentLeads(input)
  const leads = findLeads(input.exported.records, found.leads)
  return { found, leadsMd: leads.markdown, leadIds: leads.ids, humanLeads: leads.humanLeads }
}

/**
 * Everything the reviewer is handed, by file name, plus the prompt it starts from: the
 * session, the contract, the leads it must answer one by one, the script that checks it did,
 * and the empty review. One function so the CLI and the server stage exactly the same workspace.
 */
export const problemReviewFiles = (
  exported: SessionExport,
  instructions: string,
  /** leads.md from `prepareProblems`; without it (a dry run), only what code finds. */
  leadsMd: string = findLeads(exported.records).markdown,
): { files: Readonly<Record<string, string>>; prompt: string } => ({
  files: {
    "session.json": sessionJsonText(exported),
    "CONTRACT.md": assembleReviewContract(instructions),
    "leads.md": leadsMd,
    "leads-answered.md": "",
    "check.mjs": LEAD_CHECK_SCRIPT,
    "review.md": reviewMdSkeleton(),
  },
  prompt: buildProblemReviewPrompt({ title: exported.meta.title }),
})

/** A user may ask for up to this many extra fields; each becomes required on every problem. */
export const MAX_EXTRA_FIELDS = 10

const EXTRA_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/

/**
 * The extra fields a user's prompt asked for, read from the merged instructions'
 * `## Extra fields` section (one `- name: what goes in it` line each). Code, not the reviewer,
 * decides they are required: a reviewer that skips one loses that problem. A name that is not
 * one short word, or too many of them, throws — better to fail the merge than to silently
 * drop every problem a review finds.
 */
export const requiredExtraFields = (instructions: string): string[] => {
  const names: string[] = []
  for (const line of section(instructions.split("\n"), "extra fields") ?? []) {
    if (/^#\s/.test(line)) break
    const match = /^\s*-\s+(.+?):/.exec(line)
    if (match?.[1] === undefined) continue
    const name = match[1].replace(/[*`]/g, "").trim().toLowerCase()
    if (!EXTRA_NAME_RE.test(name))
      throw new Error(`"${match[1].trim()}" under Extra fields is not a field name`)
    names.push(name)
  }
  if (names.length > MAX_EXTRA_FIELDS) throw new Error(`more than ${MAX_EXTRA_FIELDS} extra fields`)
  return names
}

export type ProblemReviewResult =
  | {
      readonly ok: true
      readonly review: ProblemReview
      /** Every problem thrown away, and why: format, limits, or evidence not in the session. */
      readonly dropped: ReadonlyArray<string>
      /**
       * Lead ids leads-answered.md never answers, or answers in a way that does not hold —
       * what the reviewer skipped.
       */
      readonly unaccountedLeads: ReadonlyArray<string>
    }
  | { readonly ok: false; readonly errors: ReadonlyArray<string> }

/**
 * Reads back what the reviewer wrote and keeps only what holds: the format and limits, then
 * every quote against the session. Nothing the reviewer claims is kept unchecked. Its answers
 * to the leads are read too, to say which leads it skipped.
 */
export const readProblemReview = (
  markdown: string,
  records: ReadonlyArray<SessionExportRecord>,
  options: {
    /** From `requiredExtraFields`: every problem must carry each of these in its Extra line. */
    readonly extraFields?: ReadonlyArray<string>
    /** Every lead id in leads.md, and the reviewer's leads-answered.md. */
    readonly leadIds?: ReadonlyArray<string>
    readonly leadAnswers?: string
    /** The leads that are the person's own messages, from `findLeads`. */
    readonly humanLeads?: Leads["humanLeads"]
  } = {},
): ProblemReviewResult => {
  const extraFields = options.extraFields ?? []
  if (Buffer.byteLength(markdown) > MAX_REVIEW_MD_BYTES)
    return { ok: false, errors: [`review.md is larger than ${MAX_REVIEW_MD_BYTES} bytes`] }
  const parsed = parseReviewMd(markdown)
  if (!parsed.ok) return parsed
  const missingExtra: string[] = []
  const complete = parsed.value.problems.filter((problem) => {
    const missing = extraFields.filter((name) => (problem.extra[name] ?? "") === "")
    for (const name of missing) missingExtra.push(`"${problem.title}": missing Extra "${name}"`)
    return missing.length === 0
  })
  const checked = checkEvidence({ ...parsed.value, problems: complete }, records)
  const answers = answersOf(options.leadAnswers ?? "")
  const ownMessage = new Map((options.humanLeads ?? []).map((lead) => [lead.id, lead.msgId]))
  const quote = quoteChecker(records)
  return {
    ok: true,
    review: checked.review,
    dropped: [...parsed.dropped, ...missingExtra, ...checked.dropped],
    unaccountedLeads: (options.leadIds ?? []).filter(
      (id) => !answerHolds(answers.get(id), ownMessage.get(id), quote),
    ),
  }
}

/** What the readers did, saved beside the review. */
export type ReadersSummary = {
  readonly pieces: number
  readonly leads: number
  readonly dropped: ReadonlyArray<string>
  readonly failedPieces: ReadonlyArray<string>
}

/** review.md, read at most one byte past the cap so an oversized file is refused, not cut. */
const readReviewMd = async (path: string): Promise<string | null> => {
  const handle = await open(path, "r").catch(() => null)
  if (handle === null) return null
  try {
    const buffer = Buffer.alloc(MAX_REVIEW_MD_BYTES + 1)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    return buffer.subarray(0, bytesRead).toString("utf8")
  } finally {
    await handle.close()
  }
}

/**
 * Reads back what the reviewer left in its workspace: review.md, checked by
 * `readProblemReview` against the session and the leads, and its leads-answered.md.
 * `markdown` is null when review.md is missing or still the untouched skeleton. One function
 * so the CLI and the server read a review exactly the same way.
 */
export const readProblemWorkspace = async (input: {
  readonly workspaceDir: string
  readonly records: ReadonlyArray<SessionExportRecord>
  readonly instructions: string
  readonly prepared: PreparedProblems
}): Promise<
  { readonly leadAnswers: string; readonly readers: ReadersSummary } & (
    | { readonly markdown: null }
    | { readonly markdown: string; readonly result: ProblemReviewResult }
  )
> => {
  const { found, leadIds, humanLeads } = input.prepared
  const readers = {
    pieces: found.pieceCount,
    leads: found.leads.length,
    dropped: [...found.dropped],
    failedPieces: [...found.failedPieces],
  }
  const leadAnswers = await readOr(join(input.workspaceDir, "leads-answered.md"))
  const markdown = await readReviewMd(join(input.workspaceDir, "review.md"))
  if (markdown === null || markdown.trim() === reviewMdSkeleton().trim())
    return { markdown: null, leadAnswers, readers }
  const result = readProblemReview(markdown, input.records, {
    extraFields: requiredExtraFields(input.instructions),
    leadIds,
    leadAnswers,
    humanLeads,
  })
  return { markdown, result, leadAnswers, readers }
}
