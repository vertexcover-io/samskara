import { buildSessionExport, type NormalizedMessage, type SessionExport } from "@samskara/core"

/**
 * The session id the reviewer sees. The real id is withheld: it is the one key that would let
 * an agent look this session up in its own database and cite ids the export never gave it.
 */
export const REVIEW_SESSION_ALIAS = "session-under-review"

/**
 * A stored session as a review reads it: its messages turned into records numbered msg-0,
 * msg-1, …. One function for the reviewer and for the learning run's evidence excerpts, so
 * both build the same records from the same messages.
 */
export const reviewSessionExport = (input: {
  readonly session: {
    readonly id: string
    readonly title: string | null
    readonly source: string
    readonly startedAt?: string | null
    /** Sessions have no true endedAt column; lastActiveAt is the honest approximation. */
    readonly lastActiveAt?: string
  }
  /** The stored `messages` rows; their jsonb is the captured shape. */
  readonly messages: ReadonlyArray<unknown>
  /** Every message whole (the problems review), or excerpts (the lens review). */
  readonly full: boolean
}): SessionExport =>
  buildSessionExport({
    sessionId: REVIEW_SESSION_ALIAS,
    title: input.session.title ?? input.session.id,
    source: input.session.source,
    ...(input.session.startedAt == null ? {} : { startedAt: input.session.startedAt }),
    ...(input.session.lastActiveAt === undefined ? {} : { endedAt: input.session.lastActiveAt }),
    messages: input.messages as ReadonlyArray<NormalizedMessage>,
    full: input.full,
  })
