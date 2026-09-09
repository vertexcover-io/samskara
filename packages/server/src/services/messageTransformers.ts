import { isTaskNotificationLine, type NormalizedMessage } from "@samskara/core"

export type FlatMessage = {
  readonly message: NormalizedMessage
  readonly lineUuid: string
  readonly lineNumber: number
  readonly raw: unknown
  readonly sourceRelativePath: string
  readonly isSubagent: boolean
}

export type MessageTransformer = {
  readonly name: string
  readonly apply: (flat: FlatMessage) => FlatMessage
}

export type TransformResult = {
  readonly messages: ReadonlyArray<FlatMessage>
  readonly changed: ReadonlyMap<string, number>
}

export const applyTransformers = (
  messages: ReadonlyArray<FlatMessage>,
  transformers: ReadonlyArray<MessageTransformer> = MESSAGE_TRANSFORMERS,
): TransformResult => {
  const changed = new Map<string, number>(transformers.map((t) => [t.name, 0]))
  const runOne = (current: FlatMessage, transformer: MessageTransformer): FlatMessage => {
    const next = transformer.apply(current)
    if (next !== current) changed.set(transformer.name, (changed.get(transformer.name) ?? 0) + 1)
    return next
  }
  const out = messages.map((message) => transformers.reduce(runOne, message))
  return { messages: out, changed }
}

/**
 * Delete this entry once its count in the "Ingestion completed" line has been zero across a full
 * release: that means every CLI still uploading sets `subType` itself.
 */
export const taskNotificationSubType: MessageTransformer = {
  name: "task-notification-subtype",
  apply: (flat) => {
    const { message } = flat
    if (message.msgType !== "message" || message.role !== "user") return flat
    if (message.subType !== undefined) return flat
    if (!isTaskNotificationLine(flat.raw)) return flat
    return { ...flat, message: { ...message, subType: "taskNotification" } }
  },
}

export const MESSAGE_TRANSFORMERS: ReadonlyArray<MessageTransformer> = [taskNotificationSubType]
