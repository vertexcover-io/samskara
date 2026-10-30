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
