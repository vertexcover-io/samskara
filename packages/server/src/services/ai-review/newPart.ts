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
 * The session's messages split at what the base run read. `fresh` holds every message with a
 * later `timestamp` than `after`, or no timestamp and stored after `finishedAt`, plus each tool
 * call from the earlier part whose result is fresh: it is read again with its result. `earlier`
 * holds the rest. Both keep the input's order, which is the order the reviewer reads.
 */
export const splitNewPart = <M extends SplitMessage>(
  messages: ReadonlyArray<M>,
  boundary: { readonly after: string | null; readonly finishedAt: Date },
): { readonly earlier: M[]; readonly fresh: M[] } => {
  const after = boundary.after === null ? Number.NEGATIVE_INFINITY : msOf(boundary.after)
  const isNew = (message: M): boolean =>
    message.timestamp === null
      ? msOf(message.createdAt) > boundary.finishedAt.getTime()
      : msOf(message.timestamp) > after
  const freshResults = new Set(
    messages
      .filter((message) => message.msgType === "toolResult" && isNew(message))
      .flatMap((message) => callIdOf(message) ?? []),
  )
  const reread = (message: M): boolean =>
    message.msgType === "toolCall" && freshResults.has(callIdOf(message) ?? "")
  const fresh = messages.filter((message) => isNew(message) || reread(message))
  const freshIds = new Set(fresh.map((message) => message.id))
  return { earlier: messages.filter((message) => !freshIds.has(message.id)), fresh }
}
