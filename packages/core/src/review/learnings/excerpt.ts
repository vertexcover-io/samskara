import type { SessionExportRecord } from "../export.js"
import { shortenForReader } from "../problems/finder.js"
import { type Evidence, idsLabel } from "../problems/reviewMd.js"

/** Records shown on each side of a cited range, so the excerpt shows what led up to it. */
const EXCERPT_AROUND = 3

/**
 * A session's records numbered the way its review numbered them. A review saves the real
 * message id of each msg-N (`recordIds`), because exporting the same session again can order
 * records that tie differently; a position whose message is gone becomes an empty record.
 */
export const recordsInReviewOrder = (
  records: ReadonlyArray<SessionExportRecord>,
  recordIds: ReadonlyArray<string | null>,
): SessionExportRecord[] => {
  const bySource = new Map<string, SessionExportRecord>()
  for (const record of records)
    if (record.sourceId !== undefined && !bySource.has(record.sourceId))
      bySource.set(record.sourceId, record)
  return recordIds.map((id, index) => {
    const found = id === null ? undefined : bySource.get(id)
    return {
      ...(found ?? { msgType: "message", track: "main", text: "" }),
      seq: index,
      id: `msg-${index}`,
    }
  })
}

const numberOf = (id: string): number => Number(id.replace(/^msg-/, ""))

/**
 * The real message id behind a review's `msg-N`, or null when it cannot be found: the review
 * kept no record order (`recordIds` null), N is outside it, or that message is gone.
 */
export const messageIdAt = (
  recordIds: ReadonlyArray<string | null> | null,
  alias: string,
): string | null => {
  const match = /^msg-(\d+)$/.exec(alias)
  if (match === null || recordIds === null) return null
  return recordIds[Number(match[1])] ?? null
}

/** One record as a line block: who or which tool, then what it said, cut like a reader's. */
const recordBlock = (record: SessionExportRecord): string => {
  const cut = shortenForReader(record)
  const who =
    cut.toolName === undefined
      ? (cut.role ?? cut.msgType)
      : `${cut.toolName}${cut.status === undefined ? "" : `, ${cut.status}`}`
  const parts = [
    cut.text,
    cut.input === undefined ? undefined : `input: ${cut.input}`,
    cut.output === undefined ? undefined : `output: ${cut.output}`,
  ].filter((part): part is string => part !== undefined && part !== "")
  return [`[${cut.id}] ${who}${cut.track === "main" ? "" : ` (${cut.track})`}:`, ...parts].join(
    "\n",
  )
}

/**
 * A problem's evidence with the session around it: each evidence line as the reviewer wrote
 * it (ids, quote, why), then the records it cites and `EXCERPT_AROUND` on each side.
 */
export const problemExcerpt = (
  records: ReadonlyArray<SessionExportRecord>,
  evidence: ReadonlyArray<Evidence>,
): string =>
  evidence
    .map((item) => {
      const from = Math.max(0, numberOf(item.from) - EXCERPT_AROUND)
      const to = Math.min(records.length - 1, numberOf(item.to) + EXCERPT_AROUND)
      return [
        `${idsLabel(item)} — "${item.quote}" — ${item.why}`,
        "",
        "```text",
        records
          .slice(from, to + 1)
          .map(recordBlock)
          .join("\n\n")
          .replaceAll("```", "'''"),
        "```",
      ].join("\n")
    })
    .join("\n\n")

/** Messages shown on each side of a quote on the fix page: enough to read what led to it. */
const MESSAGES_AROUND = 2

/** One message as a reader sees it beside a quote. */
export type EvidenceMessage = {
  readonly id: string
  /** The role, or the tool's name and status. */
  readonly who: string
  /** Where it was said: `main`, or the helper agent it came from. */
  readonly track: string
  readonly text: string
  readonly input?: string
  readonly output?: string
  /** Whether the quote cites it, as opposed to the context around it. */
  readonly cited: boolean
}

/**
 * A tool call's input as a reader would write it: the JSON a call was made with, its text
 * fields as plain lines. One field is shown as its value alone (`{"command":"ls"}` reads `ls`).
 */
const readableInput = (input: string): string => {
  let parsed: unknown
  try {
    parsed = JSON.parse(input)
  } catch {
    return input
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return input
  const entries = Object.entries(parsed)
  const shown = (value: unknown): string =>
    typeof value === "string" ? value : JSON.stringify(value, null, 2)
  if (entries.length === 1) return shown(entries[0]?.[1])
  return entries.map(([key, value]) => `${key}: ${shown(value)}`).join("\n")
}

const hasContent = (record: SessionExportRecord): boolean =>
  (record.text ?? "") !== "" || record.input !== undefined || record.output !== undefined

/**
 * The messages a quote cites and `MESSAGES_AROUND` on each side, cut like a reader's. The ones
 * around it come from the same agent as the quote: helpers run side by side, so the records next
 * to it in the session are often another helper's. Empty records (usage, markers) are left out.
 */
export const evidenceMessages = (
  records: ReadonlyArray<SessionExportRecord>,
  item: Evidence,
): EvidenceMessage[] => {
  const first = numberOf(item.from)
  const last = numberOf(item.to)
  const track = records[first]?.track
  const around = (record: SessionExportRecord) => record.track === track && hasContent(record)
  const before = records.slice(0, first).filter(around).slice(-MESSAGES_AROUND)
  const after = records
    .slice(last + 1)
    .filter(around)
    .slice(0, MESSAGES_AROUND)
  const cited = records.slice(first, last + 1)
  const shownCited = cited.some(hasContent) ? cited.filter(hasContent) : cited
  return [...before, ...shownCited, ...after].map((record) => {
    const seq = numberOf(record.id)
    const isCited = seq >= first && seq <= last
    const readable =
      record.input === undefined ? record : { ...record, input: readableInput(record.input) }
    // The quoted message is the proof, so it is shown whole; the ones around it are context.
    const cut = isCited ? readable : shortenForReader(readable)
    return {
      id: cut.id,
      who:
        cut.toolName === undefined
          ? (cut.role ?? cut.msgType)
          : `${cut.toolName}${cut.status === undefined ? "" : `, ${cut.status}`}`,
      track: cut.track,
      text: cut.text ?? "",
      ...(cut.input === undefined ? {} : { input: cut.input }),
      ...(cut.output === undefined ? {} : { output: cut.output }),
      cited: isCited,
    }
  })
}
