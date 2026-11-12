import { SILENT_MESSAGE_TYPES } from "../../repositories/reviews.repo.js"

/** The fields of a stored message this split reads. */
type SplitMessage = {
  readonly id: string
  readonly msgType: string
  readonly timestamp: string | null
  readonly createdAt: string
  readonly details: unknown
}

const callIdOf = (message: SplitMessage): string | undefined => {
  const callId = (message.details as { callId?: unknown } | null)?.callId
  return typeof callId === "string" ? callId : undefined
}

const msOf = (time: string): number => new Date(time).getTime()

/**
 * The session's messages split at what the base run read. A message is late when its
 * `timestamp` is after `after`, or it has none and was stored after `finishedAt`. `fresh` holds
 * every late message other than a silent one (`SILENT_MESSAGE_TYPES`), plus each tool call from
 * the earlier part whose result is fresh: it is read again with its result. `earlier` holds the
 * messages that are not late. A late silent message is in neither: in `earlier` it would take the
 * context records meant for the end of the reviewed part. Both keep the input's order, which is
 * the order the reviewer reads.
 */
export const splitNewPart = <M extends SplitMessage>(
  messages: ReadonlyArray<M>,
  boundary: { readonly after: string | null; readonly finishedAt: Date },
): { readonly earlier: M[]; readonly fresh: M[] } => {
  const after = boundary.after === null ? Number.NEGATIVE_INFINITY : msOf(boundary.after)
  const isLate = (message: M): boolean =>
    message.timestamp === null
      ? msOf(message.createdAt) > boundary.finishedAt.getTime()
      : msOf(message.timestamp) > after
  const isNew = (message: M): boolean =>
    isLate(message) && !SILENT_MESSAGE_TYPES.includes(message.msgType)
  const freshResults = new Set(
    messages
      .filter((message) => message.msgType === "toolResult" && isNew(message))
      .flatMap((message) => callIdOf(message) ?? []),
  )
  const reread = (message: M): boolean =>
    message.msgType === "toolCall" && freshResults.has(callIdOf(message) ?? "")
  const fresh = messages.filter((message) => isNew(message) || reread(message))
  const freshIds = new Set(fresh.map((message) => message.id))
  return {
    earlier: messages.filter((message) => !freshIds.has(message.id) && !isLate(message)),
    fresh,
  }
}
