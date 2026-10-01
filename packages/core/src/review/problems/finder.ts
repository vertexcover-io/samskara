import { readFile } from "node:fs/promises"
import { join } from "node:path"
import type { SessionExport, SessionExportRecord } from "../lenses/export.js"
import type { HarnessRunInput, HarnessRunner } from "../runner.js"
import { sessionJsonText } from "./contract.js"
import { MAIN_TRACK, QUESTION_TOOLS } from "./leads.js"
import { type Evidence, parseEvidenceLine, quoteChecker } from "./reviewMd.js"
import { withWorkspace } from "./workspace.js"

/**
 * How much of a session one reader gets, in characters of record JSON (about 125K tokens).
 * Most of a long session is tool output, and readers see little of it (`shortenForReader`), so
 * a piece this size holds a long stretch of what the agent and the person said.
 */
const PIECE_CHARS = 500_000

/** The most leads one reader may hand back; past it, it is listing, not judging. */
const MAX_LEADS_PER_PIECE = 40

/** How many readers run at once. */
const READER_CONCURRENCY = 4

/** How much of the start and of the end of a long tool input or failed output a reader is shown. */
const EDGE_CHARS = 1000

/** Lines worth keeping from output a reader is not shown, and how many of them at most. */
const SIGNAL_RE =
  /error|fail|warn|deprecat|denied|exception|panic|traceback|secret|token\s*[=:]|password|api[_-]?key|xox[abp]-|ghp_|sk-[a-z0-9]|AKIA/i
const MAX_SIGNAL_LINES = 20
const SIGNAL_LINE_CHARS = 300

export type Piece = {
  readonly label: string
  readonly records: ReadonlyArray<SessionExportRecord>
}

/**
 * Cuts a session into pieces one reader can read whole: the main conversation in slices
 * under the budget, and each helper's conversation on its own (sliced too when it is big).
 * Pieces come back in the order they started, so readers' leads read like the session did.
 */
export const splitIntoPieces = (
  records: ReadonlyArray<SessionExportRecord>,
  budget: number = PIECE_CHARS,
): Piece[] => {
  const byTrack = new Map<string, SessionExportRecord[]>()
  for (const record of records)
    byTrack.set(record.track, [...(byTrack.get(record.track) ?? []), record])

  const pieces: Piece[] = []
  for (const [track, trackRecords] of byTrack) {
    const slices: SessionExportRecord[][] = []
    let current: SessionExportRecord[] = []
    let size = 0
    for (const record of trackRecords) {
      const cost = JSON.stringify(record).length
      if (current.length > 0 && size + cost > budget) {
        slices.push(current)
        current = []
        size = 0
      }
      current.push(record)
      size += cost
    }
    if (current.length > 0) slices.push(current)
    const name = track === MAIN_TRACK ? "main" : `helper ${track}`
    for (const [index, slice] of slices.entries())
      pieces.push({
        label: track === MAIN_TRACK || slices.length > 1 ? `${name}, part ${index + 1}` : name,
        records: slice,
      })
  }
  const startOf = (piece: Piece): number => piece.records[0]?.ts ?? piece.records[0]?.seq ?? 0
  return pieces.sort((left, right) => startOf(left) - startOf(right))
}

/** Up to `MAX_SIGNAL_LINES` lines of `text` that mention an error, a warning or a secret. */
const signalLines = (text: string): string[] =>
  text
    .split("\n")
    .filter((line) => SIGNAL_RE.test(line))
    .slice(0, MAX_SIGNAL_LINES)
    .map((line) => line.slice(0, SIGNAL_LINE_CHARS))

/** A long text cut to its start and end, keeping signal lines from the middle if asked. */
const shorten = (text: string, keepSignals: boolean): string => {
  // Not worth it unless the cut saves more than the note it leaves behind.
  if (text.length <= EDGE_CHARS * 2 + 500) return text
  const middle = text.slice(EDGE_CHARS, -EDGE_CHARS)
  const kept = keepSignals ? signalLines(middle) : []
  const note = `[… ${middle.length.toLocaleString("en-US")} characters cut; the full text is in the session${kept.length > 0 ? ". Lines kept from the cut part:" : ""} …]`
  return [
    text.slice(0, EDGE_CHARS),
    note,
    ...kept,
    ...(kept.length > 0 ? ["[… end of kept lines …]"] : []),
    text.slice(-EDGE_CHARS),
  ].join("\n")
}

/** The output of a call that worked: only its signal lines, and a note of what was left out. */
const leaveOut = (text: string): string => {
  const kept = signalLines(text)
  return [
    `[… output left out, the call worked: ${text.length.toLocaleString("en-US")} characters, the full text is in the session${kept.length > 0 ? ". Lines kept from it:" : ""} …]`,
    ...kept,
  ].join("\n")
}

/**
 * A record as a reader sees it. Most of a long session is file contents and command output, and
 * a reader judging what the agent did needs little of it: the output of a call that worked is
 * left out, and a failed one is cut to its start and end. From both, lines that mention an
 * error, a warning or a secret are kept, since those are problems in themselves. The person's
 * answer to a question is kept whole, and a long input is cut to its edges. The full text stays
 * in the session the reviewer gets, and a quote from what the reader saw is still there.
 */
export const shortenForReader = (record: SessionExportRecord): SessionExportRecord => {
  if (record.output !== undefined && QUESTION_TOOLS.has(record.toolName?.toLowerCase() ?? ""))
    return record
  const input = record.input === undefined ? undefined : shorten(record.input, false)
  const output =
    record.output === undefined
      ? undefined
      : record.status === "failure"
        ? shorten(record.output, true)
        : leaveOut(record.output)
  if (input === record.input && output === record.output) return record
  return {
    ...record,
    ...(input === undefined ? {} : { input }),
    ...(output === undefined ? {} : { output }),
  }
}

/**
 * Every well-formed lead line in a reader's leads.md — `- msg-3 to msg-5 — "exact words" —
 * why`, the same shape as an evidence line; anything else is ignored.
 */
export const parseFoundLeads = (markdown: string): Evidence[] =>
  markdown.split("\n").flatMap((line) => {
    const item = /^\s*-\s+(msg-\d+.*)$/.exec(line)
    const lead = item?.[1] === undefined ? undefined : parseEvidenceLine(item[1])
    return lead === undefined ? [] : [lead]
  })

/** What a reader is told. Its instructions come from the review, so a user's own rules apply. */
const READER_CONTRACT = `# Read one piece of a session

You are one of several readers of a recorded AI agent session. Each reader gets one piece.
Yours is \`piece.json\`: one record per line, each with an \`id\` (\`msg-N\`), \`track\`, \`ts\`,
and \`text\`, or for a tool call \`toolName\`, \`input\`, \`status\` and \`output\`.

Read every record in it, in order. It is small enough to read whole — do not search and skip.
\`INSTRUCTIONS.md\` says what counts as a problem in this session; use its goal, steps and
rules, and ignore anything it says about writing a review.

Write \`leads.md\`: one line for each thing in your piece that may be a problem.

\`\`\`
- msg-120 to msg-134 — "the exact words from those records" — why it may be a problem
\`\`\`

- The quote must be words that really appear in those records (text, input or output), at
  least a few characters. Code checks it and drops the lead if it is not there.
- Tool output is mostly left out: a call that worked shows only its lines that mention an
  error, a warning or a secret, and a long failed one only its start and end. Both are marked
  \`[… …]\`. Quote only words you can see, never the marker. If what was left out may matter,
  say so in the lead.
- Look past errors. Also note: a claim the agent makes that turns out wrong; a blocked command
  worked around instead of reported; a warning or a secret in the output of a command that
  succeeded; the person correcting, repeating or not understanding; a step that tested or
  checked the wrong thing; two rules or documents that disagree; work done by hand that a
  step should have done.
- At most ${MAX_LEADS_PER_PIECE} lines. If nothing in your piece may be a problem, write
  \`Nothing found.\`
- Your final reply is one short line.
`

const readerPrompt = (label: string): string =>
  [
    `You are reading one piece of a recorded AI agent session: ${label}.`,
    "Read `READER.md` first, then all of `piece.json`, and write `leads.md`.",
    "The file is the deliverable. Your final reply is one short line.",
  ].join("\n")

export type FoundLeads = {
  /** Leads that passed the quote check, each with the piece it came from. */
  readonly leads: ReadonlyArray<Evidence & { readonly piece: string }>
  /** Leads thrown away, and why. */
  readonly dropped: ReadonlyArray<string>
  /** Pieces whose reader failed or wrote nothing — read by no one. */
  readonly failedPieces: ReadonlyArray<string>
  readonly pieceCount: number
}

/** Runs `work` over `items`, at most `limit` at a time, keeping the input order. */
const inBatches = async <T, R>(
  items: ReadonlyArray<T>,
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> => {
  const results: R[] = new Array(items.length)
  let next = 0
  const lane = async (): Promise<void> => {
    while (next < items.length) {
      const index = next
      next += 1
      results[index] = await work(items[index] as T)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane))
  return results
}

/**
 * The first stage of a problems review: the session cut into pieces and each piece read whole
 * by its own reader run, side by side. A reader that fails leaves its piece unread and is
 * recorded, but does not fail the review — the code leads still cover that piece.
 */
export const findAgentLeads = async (input: {
  readonly exported: SessionExport
  readonly instructions: string
  readonly runner: HarnessRunner
  readonly run?: Pick<HarnessRunInput, "harness" | "model">
}): Promise<FoundLeads> => {
  const pieces = splitIntoPieces(input.exported.records.map(shortenForReader))
  // Checked against the full records: a quote from what a reader was shown is in them too.
  // A lead only points the way, so its range and reason are not limited — only its words
  // must really be there.
  const check = quoteChecker(input.exported.records, Number.POSITIVE_INFINITY)
  const outcomes = await inBatches(pieces, READER_CONCURRENCY, (piece) =>
    withWorkspace(
      "samskara-review-reader-",
      {
        "piece.json": sessionJsonText({ ...input.exported, records: piece.records }),
        "INSTRUCTIONS.md": input.instructions,
        "READER.md": READER_CONTRACT,
      },
      async (workspaceDir) => {
        await input.runner.run({ ...input.run, prompt: readerPrompt(piece.label), workspaceDir })
        const markdown = await readFile(join(workspaceDir, "leads.md"), "utf8").catch(() => null)
        if (markdown === null) return { piece, failed: "wrote no leads.md" }
        return { piece, found: parseFoundLeads(markdown).slice(0, MAX_LEADS_PER_PIECE) }
      },
    ).catch((error: unknown) => ({
      piece,
      failed: error instanceof Error ? error.message : String(error),
    })),
  )

  const leads: Array<Evidence & { piece: string }> = []
  const dropped: string[] = []
  const failedPieces: string[] = []
  for (const outcome of outcomes) {
    if ("failed" in outcome) {
      failedPieces.push(`${outcome.piece.label}: ${outcome.failed}`)
      continue
    }
    for (const lead of outcome.found ?? []) {
      const error = check(lead)
      if (error === undefined) leads.push({ ...lead, piece: outcome.piece.label })
      else dropped.push(`${outcome.piece.label}: ${error}`)
    }
  }
  return { leads, dropped, failedPieces, pieceCount: pieces.length }
}
