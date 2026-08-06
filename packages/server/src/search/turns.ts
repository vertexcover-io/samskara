/** The subset of `messages` a chunker needs to derive turn boundaries. */
export type ChunkSourceRow = {
  readonly id: string
  readonly lineNumber: number
  readonly trackId: string
  readonly agentId: string | null
  readonly msgType: string
  readonly role: string | null
}

/**
 * One closed turn on one track, expressed as a line range plus the message that opened it. Never
 * built for the in-flight (final, unclosed) turn of a track -- see `deriveTurns`.
 */
export type TurnRange = {
  readonly trackId: string
  readonly agentId: string | null
  readonly startLineNumber: number
  readonly endLineNumber: number
  readonly anchorMessageId: string
}

// `turnEvent` fires on only 29% of turns in current data, so it cannot be the
// terminator -- only a fresh user message opens (and thereby closes the previous) turn.
const opensTurn = (row: ChunkSourceRow): boolean => row.msgType === "message" && row.role === "user"

/**
 * A turn opens at a `user` message on a track and closes at the next one on that same track.
 * Derived per track so subagent output never interleaves into a parent turn. The final turn of
 * every track is dropped: it is still in flight, so its text would change under an
 * already-computed embedding.
 */
export const deriveTurns = (rows: ReadonlyArray<ChunkSourceRow>): ReadonlyArray<TurnRange> => {
  const sorted = [...rows].sort((a, b) => a.lineNumber - b.lineNumber)

  const byTrack = new Map<string, ChunkSourceRow[]>()
  for (const row of sorted) {
    const track = byTrack.get(row.trackId)
    if (track) track.push(row)
    else byTrack.set(row.trackId, [row])
  }

  const turns: TurnRange[] = []
  for (const [trackId, trackRows] of byTrack) {
    let open: ChunkSourceRow | undefined
    for (const current of trackRows) {
      if (!opensTurn(current)) continue
      if (open) {
        turns.push({
          trackId,
          agentId: open.agentId,
          startLineNumber: open.lineNumber,
          endLineNumber: current.lineNumber - 1,
          anchorMessageId: open.id,
        })
      }
      open = current
    }
  }

  return turns
}
