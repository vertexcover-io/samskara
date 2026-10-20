import type { SessionExportRecord } from "../lenses/export.js"
import { type Evidence, idsLabel } from "./reviewMd.js"

const GAP_MS = 5 * 60_000
const REPEAT_MIN = 3
const LINE_CHARS = 200
/** The track the person talks in. A helper's "user" messages are the main agent's instructions. */
export const MAIN_TRACK = "main"

const INTERRUPT_RE = /\[Request interrupted/i
/** Tools whose output is the person answering the agent's question; compare lowercased. */
export const QUESTION_TOOLS = new Set(["askuserquestion"])

const oneLine = (text: string | undefined): string =>
  (text ?? "").replace(/\s+/g, " ").trim().slice(0, LINE_CHARS)

/**
 * Typed by the person: a user message in the main track that is not marked as anything else.
 * Helper notices, reminders and injected skill text are stored as user messages too.
 */
const isHuman = (record: SessionExportRecord): boolean =>
  record.track === MAIN_TRACK &&
  record.msgType === "message" &&
  record.role === "user" &&
  (record.origin === undefined || record.origin === "human") &&
  (record.text ?? "") !== ""

const minutes = (ms: number): string => `${Math.round(ms / 60_000)}m`

export type Leads = {
  /** leads.md: every lead, one line each, starting with its id. */
  readonly markdown: string
  /** Every lead id, in order — what the review must account for, one by one. */
  readonly ids: ReadonlyArray<string>
  /**
   * The leads that are the person's own messages, each with the message it is. One may be
   * dropped only by quoting that message, so a correction is never waved through unread.
   */
  readonly humanLeads: ReadonlyArray<{ readonly id: string; readonly msgId: string }>
}

/** The section the person's own messages are listed under. */
export const HUMAN_SECTION = "Human messages"

/**
 * Every place in the session worth a closer look, each with an id (`L1`, `L2`, …): what the
 * readers found, then what code finds on its own. The reviewer must say what it did
 * with every one — kept as a problem or dropped with a reason — which is what stops it from
 * skimming a long session and stopping early. A lead is not a problem.
 */
export const findLeads = (
  records: ReadonlyArray<SessionExportRecord>,
  /** What the reader agents found by reading every piece; listed first, before code's leads. */
  found: ReadonlyArray<Evidence & { readonly piece: string }> = [],
): Leads => {
  const sections: Array<[string, string[]]> = []

  sections.push([
    "Found by reading",
    found.map(
      (lead) =>
        `${idsLabel(lead)}: "${oneLine(lead.quote)}" — ${oneLine(lead.why)} (${lead.piece})`,
    ),
  ])

  sections.push([
    HUMAN_SECTION,
    records
      .filter((record) => isHuman(record) && !INTERRUPT_RE.test(record.text ?? ""))
      .map((record) => `${record.id}: ${oneLine(record.text)}`),
  ])

  sections.push([
    "Interrupts",
    records.filter((record) => INTERRUPT_RE.test(record.text ?? "")).map((record) => record.id),
  ])

  sections.push([
    "Questions the agent asked",
    records
      .filter(
        (record) =>
          (record.track === MAIN_TRACK &&
            record.msgType === "message" &&
            record.role === "assistant" &&
            /\?\s*$/.test(record.text ?? "")) ||
          (record.toolName !== undefined && QUESTION_TOOLS.has(record.toolName.toLowerCase())),
      )
      .map((record) =>
        record.toolName === undefined
          ? `${record.id}: ${oneLine(record.text)}`
          : // The answer is the part that matters: it is the person talking.
            `${record.id}: ${record.toolName}${record.output ? ` → ${oneLine(record.output)}` : ""}`,
      ),
  ])

  const failures = records.filter((record) => record.status === "failure")
  const failuresByTool = new Map<string, string[]>()
  for (const record of failures) {
    const tool = record.toolName ?? "tool"
    failuresByTool.set(tool, [...(failuresByTool.get(tool) ?? []), record.id])
  }
  sections.push([
    "Tool failures",
    [
      ...[...failuresByTool]
        .filter(([, ids]) => ids.length >= REPEAT_MIN)
        .map(([tool, ids]) => `${tool} failed ${ids.length} times: ${ids.join(", ")}`),
      ...failures.map(
        (record) => `${record.id}: ${record.toolName ?? "tool"} ${oneLine(record.input)}`,
      ),
    ],
  ])

  const callsByKey = new Map<string, SessionExportRecord[]>()
  for (const record of records) {
    if (record.msgType !== "toolCall" || record.toolName === undefined) continue
    const key = `${record.toolName}\u0000${record.input ?? ""}`
    callsByKey.set(key, [...(callsByKey.get(key) ?? []), record])
  }
  sections.push([
    "Repeated calls",
    [...callsByKey.values()]
      .filter((calls) => calls.length >= REPEAT_MIN)
      .map(
        (calls) =>
          `${calls[0]?.toolName} ×${calls.length}: ${calls.map((call) => call.id).join(", ")} — ${oneLine(calls[0]?.input)}`,
      ),
  ])

  // In time order across every track: records are stored track by track, so neighbours in
  // storage can be hours apart while a helper was busy in between.
  const timed = records
    .filter((record) => record.ts !== undefined)
    .sort((left, right) => (left.ts as number) - (right.ts as number))
  const gaps: string[] = []
  for (let index = 1; index < timed.length; index += 1) {
    const before = timed[index - 1]
    const after = timed[index]
    if (before === undefined || after === undefined) continue
    const gap = (after.ts as number) - (before.ts as number)
    if (gap <= GAP_MS) continue
    const why = isHuman(after) ? "waiting for the person" : "nothing running — check it"
    gaps.push(`${before.id} to ${after.id}: ${minutes(gap)}, ${why}`)
  }
  sections.push(["Gaps over 5 minutes", gaps])

  const ids: string[] = []
  const humanLeads: Array<{ id: string; msgId: string }> = []
  const filled = sections
    .filter(([, lines]) => lines.length > 0)
    .map(([title, lines]): [string, string[]] => [
      title,
      lines.map((line) => {
        const id = `L${ids.length + 1}`
        ids.push(id)
        const msgId = /^msg-\d+/.exec(line)?.[0]
        if (title === HUMAN_SECTION && msgId !== undefined) humanLeads.push({ id, msgId })
        return `- ${id} ${line}`
      }),
    ])
  if (filled.length === 0)
    return {
      markdown:
        "# Leads\n\nNo leads found by the first pass. Read the session for anything it missed.\n",
      ids,
      humanLeads,
    }
  return {
    markdown: [
      "# Leads",
      "",
      "Each is a place to look, not yet a problem. Answer every id in leads-answered.md.",
      "",
      ...filled.flatMap(([title, lines]) => [`## ${title}`, "", ...lines, ""]),
    ].join("\n"),
    ids,
    humanLeads,
  }
}
