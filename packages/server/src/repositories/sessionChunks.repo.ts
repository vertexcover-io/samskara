import { and, asc, eq } from "drizzle-orm"
import type { Querier } from "../db/client.js"
import { messages, sessionChunk, sessions, toolCall, toolResult } from "../db/schema.js"
import { CHUNK_MAX_MESSAGES } from "../search/constants.js"
import { type ToolContext, buildEmbedText, buildSearchText } from "../search/text.js"
import { deriveTurns } from "../search/turns.js"

/** A message row carrying everything both the turn-deriver and the text projections need. */
export type SourceRow = {
  readonly id: string
  readonly lineNumber: number
  readonly trackId: string
  readonly agentId: string | null
  readonly msgType: string
  readonly role: string | null
  readonly content: unknown
}

export type ChunkPart = {
  readonly partIndex: number
  readonly startLineNumber: number
  readonly endLineNumber: number
  readonly rows: ReadonlyArray<SourceRow>
}

/**
 * A turn's rows split into ordered, contiguous parts of at most `maxMessages` -- turns
 * average 34 messages in current data, so splitting is the normal path, and truncating would
 * drop the end of the turn, where conclusions live.
 */
export const splitIntoParts = (
  rows: ReadonlyArray<SourceRow>,
  maxMessages: number,
): ReadonlyArray<ChunkPart> => {
  const parts: ChunkPart[] = []
  for (let i = 0; i < rows.length; i += maxMessages) {
    const slice = rows.slice(i, i + maxMessages)
    const first = slice[0]
    const last = slice.at(-1)
    if (!first || !last) continue
    parts.push({
      partIndex: parts.length,
      startLineNumber: first.lineNumber,
      endLineNumber: last.lineNumber,
      rows: slice,
    })
  }
  return parts
}

/**
 * Read a session's messages plus their tool call/result rows, derive its closed turns, split
 * oversized turns into parts, and insert one immutable chunk row per part -- keyword-searchable
 * immediately, with `embedding` left null for the worker (phase 2). `onConflictDoNothing` on the
 * same identity the chunker re-derives every time is what makes D13 true: backfill is this same
 * function over pre-existing sessions, with no separate script and no separate retry logic.
 */
export const writeChunksForSession = async (db: Querier, sessionId: string): Promise<number> => {
  const rows = await db
    .select({
      id: messages.id,
      lineNumber: messages.lineNumber,
      trackId: messages.trackId,
      agentId: messages.agentId,
      msgType: messages.msgType,
      role: messages.role,
      content: messages.content,
      toolCallName: toolCall.toolName,
      toolCallInput: toolCall.toolInput,
      toolResultOutput: toolResult.result,
    })
    .from(messages)
    .leftJoin(toolCall, eq(toolCall.messageId, messages.id))
    .leftJoin(toolResult, eq(toolResult.messageId, messages.id))
    .where(eq(messages.sessionId, sessionId))
    .orderBy(asc(messages.lineNumber), asc(messages.subIndex))

  if (rows.length === 0) return 0

  const tools = new Map<string, ToolContext>()
  for (const row of rows) {
    if (row.msgType === "toolCall" && row.toolCallName !== null) {
      tools.set(row.id, {
        toolName: row.toolCallName,
        toolInput: row.toolCallInput,
        result: undefined,
      })
    } else if (row.msgType === "toolResult") {
      tools.set(row.id, { toolName: "", toolInput: undefined, result: row.toolResultOutput })
    }
  }

  const turns = deriveTurns(rows)
  if (turns.length === 0) return 0

  // Line numbers are per source file, not session-global: a subagent's own transcript starts
  // its own numbering at 1, so a range must be scoped by trackId as well as line number, or two
  // tracks' turns collide on the same lines.
  const rowsByTrack = new Map<string, typeof rows>()
  for (const row of rows) {
    const track = rowsByTrack.get(row.trackId)
    if (track) track.push(row)
    else rowsByTrack.set(row.trackId, [row])
  }

  const values = turns.flatMap((turn) => {
    const turnRows = (rowsByTrack.get(turn.trackId) ?? []).filter(
      (row) => row.lineNumber >= turn.startLineNumber && row.lineNumber <= turn.endLineNumber,
    )
    return splitIntoParts(turnRows, CHUNK_MAX_MESSAGES).map((part) => ({
      sessionId,
      kind: "turn" as const,
      trackId: turn.trackId,
      agentId: turn.agentId,
      partIndex: part.partIndex,
      startLineNumber: part.startLineNumber,
      endLineNumber: part.endLineNumber,
      anchorMessageId: turn.anchorMessageId,
      searchText: buildSearchText(part.rows, tools),
      embedText: buildEmbedText(part.rows, tools),
      embedding: null,
    }))
  })

  if (values.length === 0) return 0

  const inserted = await db
    .insert(sessionChunk)
    .values(values)
    .onConflictDoNothing({
      target: [
        sessionChunk.sessionId,
        sessionChunk.kind,
        sessionChunk.trackId,
        sessionChunk.startLineNumber,
        sessionChunk.partIndex,
      ],
    })
    .returning({ id: sessionChunk.id })

  return inserted.length
}

/**
 * Keeps the `kind = 'title'` chunk in sync with `sessions.title` -- a no-op until a title
 * exists, since the derived title shown in the UI is already indexed as an ordinary chunk (plan
 * correction 2) and embedding it again would double-weight it. The unique constraint can't
 * de-duplicate this row itself (its `trackId`/`startLineNumber` are both null, and Postgres never
 * treats two nulls as equal), so re-derivation is done here by comparing the stored title against
 * the existing chunk's `searchText` and replacing it on a change -- deleting first resets
 * `embedding` to null and lets the worker pick the new text up with no extra signalling.
 */
export const writeTitleChunkForSession = async (db: Querier, sessionId: string): Promise<void> => {
  const [session] = await db
    .select({ title: sessions.title })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
  if (!session?.title) return

  const [existing] = await db
    .select({ id: sessionChunk.id, searchText: sessionChunk.searchText })
    .from(sessionChunk)
    .where(and(eq(sessionChunk.sessionId, sessionId), eq(sessionChunk.kind, "title")))

  if (existing?.searchText === session.title) return
  if (existing) await db.delete(sessionChunk).where(eq(sessionChunk.id, existing.id))

  await db.insert(sessionChunk).values({
    sessionId,
    kind: "title",
    partIndex: 0,
    searchText: session.title,
    embedText: session.title,
    embedding: null,
  })
}
