import type { NormalizedMessage } from "../../ingest/types.js"
import { type AiReviewPayload, MAX_TRACKS_PER_ENTRY } from "./schema.js"

/**
 * Excerpt caps, in Unicode code units — plain slicing, so truncation is deterministic. Kept
 * tight so a 1500-message session exports far below the size where a reviewer agent starts
 * paging through the file with probes instead of reviewing it. The caps were tuned down
 * after sandbox-log analysis showed the model's read-then-draft time scaling with export
 * bytes; the excerpts are anchors to cite, not the full transcript.
 */
export const USER_TEXT_EXCERPT_CHARS = 100
export const ASSISTANT_TEXT_EXCERPT_CHARS = 60
export const REASONING_TEXT_EXCERPT_CHARS = 40

export type SessionExportRecord = {
  readonly seq: number
  readonly id: string
  /** The captured message's own id, when the input carried one — the permalink bridge back
   * to the conversation tab, which resolves real message ids, not these export aliases. */
  readonly sourceId?: string
  readonly role?: string
  readonly msgType: NormalizedMessage["msgType"]
  readonly toolName?: string
  readonly status?: string
  readonly track: string
  readonly text?: string
  /** Epoch milliseconds from the message's own timestamp, so durations derive from seq ranges. */
  readonly ts?: number
}

export type SessionExport = {
  readonly meta: {
    readonly sessionId: string
    readonly title: string
    readonly source: string
    readonly startedAt?: string
    readonly endedAt?: string
  }
  readonly records: ReadonlyArray<SessionExportRecord>
  readonly index: {
    readonly seqs: number[]
    readonly messageIds: string[]
    readonly tracks: string[]
  }
}

/**
 * Export ids are position-based (`msg-<seq>`): unique by construction, and the same value
 * as the record's seq — one number to cite, two ways. A normalized message's `subIndex` is
 * only unique per track, so minting from it duplicated ids across tracks.
 */
export const messageIdOf = (position: number): string => `msg-${position}`

const excerpt = (text: string | undefined, maxChars: number): string | undefined =>
  text === undefined ? undefined : text.slice(0, maxChars)

/** Epoch ms from a normalized timestamp; undefined when absent or unparseable. */
const tsOf = (message: NormalizedMessage): number | undefined => {
  if (message.timestamp === undefined) return undefined
  const ms = Date.parse(message.timestamp)
  return Number.isNaN(ms) ? undefined : ms
}

const textOf = (message: NormalizedMessage): string | undefined => {
  if (message.msgType !== "message") return undefined
  if (message.content.type === "reasoning") {
    return excerpt(message.content.value, REASONING_TEXT_EXCERPT_CHARS)
  }
  if (message.content.type !== "text") return undefined
  if (message.role === "user") return excerpt(message.content.value, USER_TEXT_EXCERPT_CHARS)
  if (message.role === "assistant") {
    return excerpt(message.content.value, ASSISTANT_TEXT_EXCERPT_CHARS)
  }
  return undefined
}

/**
 * Projects a normalized message list into the compact export a harness agent reads
 * (`session.json`). The export is a pre-shaped summary, not a transcript:
 *
 * - `turnEvent` and `custom` messages are dropped entirely — bookkeeping noise with no
 *   citable content.
 * - a `toolCall` and its matching `toolResult` collapse into ONE record (call + its result
 *   together, joined by callId — the same join `reviewEventsFromMessages` performs). An
 *   orphan result with no earlier call still becomes its own record, so every kept message
 *   stays citable.
 *
 * Every kept message becomes a record — seq is the position in the record list, id comes from
 * `messageIdOf`, track from the message's own trackId, ts (epoch ms) from the message's own
 * timestamp when it carried one, so durations can be derived from seq ranges server-side
 * without the reviewer ever claiming them. `index` is the grounding contract: the seqs,
 * messageIds and tracks a review payload may cite, exactly as they appear in records.
 */
export const buildSessionExport = (input: {
  readonly sessionId: string
  readonly title: string
  readonly source: string
  readonly startedAt?: string
  readonly endedAt?: string
  readonly messages: ReadonlyArray<NormalizedMessage>
}): SessionExport => {
  /** Records are assembled mutably: a result patches status into its call's record later. */
  type WritableRecord = { -readonly [K in keyof SessionExportRecord]: SessionExportRecord[K] }
  const callRecordByCallId = new Map<string, WritableRecord>()
  const records: WritableRecord[] = []
  const tracks: string[] = []
  const seenTracks = new Set<string>()

  // The captured row's own id rides along when present: the web resolves evidence permalinks
  // against real message ids, and this is the only alias→id bridge that exists.
  const sourceIdOf = (message: NormalizedMessage): string | undefined => {
    const id = (message as { id?: unknown }).id
    return typeof id === "string" && id !== "" ? id : undefined
  }

  const pushRecord = (record: WritableRecord): void => {
    records.push(record)
    if (!seenTracks.has(record.track)) {
      seenTracks.add(record.track)
      tracks.push(record.track)
    }
  }

  /** The fields every record carries, whatever kind it is; per-kind extras spread on top. */
  const baseRecord = (message: NormalizedMessage): WritableRecord => {
    const sourceId = sourceIdOf(message)
    const ts = tsOf(message)
    return {
      seq: records.length,
      id: messageIdOf(records.length),
      ...(sourceId === undefined ? {} : { sourceId }),
      msgType: message.msgType,
      track: message.trackId,
      ...(ts === undefined ? {} : { ts }),
    }
  }

  for (const message of input.messages) {
    if (message.msgType === "turnEvent" || message.msgType === "custom") continue

    if (message.msgType === "toolResult") {
      const call = callRecordByCallId.get(message.details.callId)
      if (call !== undefined) {
        // First result wins: a duplicate result for the same call is absorbed, not recorded.
        if (call.status === undefined) call.status = message.details.status
      } else {
        pushRecord({ ...baseRecord(message), status: message.details.status })
      }
      continue
    }

    if (message.msgType === "toolCall") {
      const record: WritableRecord = {
        ...baseRecord(message),
        toolName: message.details.name,
      }
      callRecordByCallId.set(message.details.callId, record)
      pushRecord(record)
      continue
    }

    const text = textOf(message)
    pushRecord({
      ...baseRecord(message),
      ...(message.msgType === "message" ? { role: message.role } : {}),
      ...(text !== undefined ? { text } : {}),
    })
  }

  return {
    meta: {
      sessionId: input.sessionId,
      title: input.title,
      source: input.source,
      ...(input.startedAt === undefined ? {} : { startedAt: input.startedAt }),
      ...(input.endedAt === undefined ? {} : { endedAt: input.endedAt }),
    },
    records,
    index: {
      seqs: records.map((record) => record.seq),
      messageIds: records.map((record) => record.id),
      tracks,
    },
  }
}

const tracksIn = (
  records: ReadonlyArray<SessionExportRecord>,
  fromSeq: number,
  toSeq: number,
): string[] =>
  [...new Set(records.slice(fromSeq, toSeq + 1).map((record) => record.track))].slice(
    0,
    MAX_TRACKS_PER_ENTRY,
  )

/**
 * Tracks are derived, never claimed. A timeline entry names a seq range, and seq is the
 * record's own position — so the tracks it spans are already in the export and the reviewer
 * never has to spell one back. Same authority rule as `model` and `harness`: whatever the
 * payload arrived with is replaced, which is why a reviewer cannot fail grounding on a track
 * it mistyped, and why the XML contract no longer has a `tracks` attribute to mistype.
 */
export const withDerivedTracks = (
  payload: AiReviewPayload,
  records: ReadonlyArray<SessionExportRecord>,
): AiReviewPayload => ({
  ...payload,
  lenses: payload.lenses.map((lens) =>
    lens.lens !== "timeline"
      ? lens
      : {
          ...lens,
          entries: lens.entries.map((entry) => ({
            ...entry,
            tracks: tracksIn(records, entry.fromSeq, entry.toSeq),
          })),
        },
  ),
})
