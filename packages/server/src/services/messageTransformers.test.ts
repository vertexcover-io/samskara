import type { NormalizedMessage } from "@samskara/core"
import { describe, expect, test } from "vitest"
import {
  applyTransformers,
  type FlatMessage,
  type MessageTransformer,
  taskNotificationSubType,
} from "./messageTransformers.js"

const baseMessage: NormalizedMessage = {
  subIndex: 0,
  sessionId: "sess-1",
  source: "claude_code",
  sourceSchemaVersion: 1,
  trackId: "main",
  msgType: "message",
  role: "user",
  content: { type: "text", value: "hello" },
}

const flatOf = (overrides: Partial<FlatMessage> = {}): FlatMessage => ({
  message: baseMessage,
  lineUuid: "line-1",
  lineNumber: 1,
  raw: { type: "text" },
  sourceRelativePath: "sess-1.jsonl",
  isSubagent: false,
  ...overrides,
})

const taskNotificationAttachmentLine = {
  type: "attachment",
  attachment: { type: "queued_command", commandMode: "task-notification" },
}

describe("applyTransformers", () => {
  test("SC1: transformers run in order, each seeing the last one's work", () => {
    const setsField: MessageTransformer = {
      name: "sets-field",
      apply: (flat) => ({ ...flat, message: { ...flat.message, trackId: "set-by-first" } }),
    }
    const readsField: MessageTransformer = {
      name: "reads-field",
      apply: (flat) =>
        flat.message.trackId === "set-by-first" && flat.message.msgType === "message"
          ? { ...flat, message: { ...flat.message, subType: "read-by-second" } }
          : flat,
    }

    const { messages } = applyTransformers([flatOf()], [setsField, readsField])
    const result = messages[0]?.message

    expect(result?.trackId).toBe("set-by-first")
    expect(result?.msgType === "message" ? result.subType : undefined).toBe("read-by-second")
  })

  test("SC2: a transformer cannot overwrite a value the client already set", () => {
    const flat = flatOf({
      message: { ...baseMessage, subType: "toolInjection" },
      raw: taskNotificationAttachmentLine,
    })

    const { messages, changed } = applyTransformers([flat], [taskNotificationSubType])

    expect(messages[0]?.message).toEqual(flat.message)
    expect(changed.get("task-notification-subtype")).toBe(0)
  })

  test("SC3: a message no transformer matches comes out exactly as it went in", () => {
    const flat = flatOf({ raw: { type: "text" } })

    const { messages } = applyTransformers([flat], [taskNotificationSubType])

    expect(messages[0]).toEqual(flat)
    expect(messages[0]).toBe(flat)
  })

  test("SC4: the ingest reports how many messages each transformer changed", () => {
    const matchesTwo: MessageTransformer = {
      name: "matches-two",
      apply: (flat) => ({ ...flat, message: { ...flat.message, trackId: "matched" } }),
    }
    const matchesNone: MessageTransformer = {
      name: "matches-none",
      apply: (flat) => flat,
    }

    const { changed } = applyTransformers([flatOf(), flatOf()], [matchesTwo, matchesNone])

    expect(changed.get("matches-two")).toBe(2)
    expect(changed.get("matches-none")).toBe(0)
  })

  test("SC5: an old-CLI task notification is given the missing value", () => {
    const flat = flatOf({ raw: taskNotificationAttachmentLine })

    const { messages, changed } = applyTransformers([flat], [taskNotificationSubType])

    expect(messages[0]?.message).toEqual({ ...baseMessage, subType: "taskNotification" })
    expect(messages[0]?.lineUuid).toBe(flat.lineUuid)
    expect(messages[0]?.raw).toBe(flat.raw)
    expect(changed.get("task-notification-subtype")).toBe(1)
  })

  test("the real transformer leaves a non-user message untouched", () => {
    const flat = flatOf({
      message: { ...baseMessage, role: "assistant" },
      raw: taskNotificationAttachmentLine,
    })

    const { messages } = applyTransformers([flat], [taskNotificationSubType])

    expect(messages[0]?.message).toEqual(flat.message)
  })

  test("the real transformer ignores a queued_command that is not a task notification", () => {
    const flat = flatOf({
      raw: { type: "attachment", attachment: { type: "queued_command", commandMode: "prompt" } },
    })

    const { messages } = applyTransformers([flat], [taskNotificationSubType])

    expect(messages[0]?.message).toEqual(flat.message)
  })
})
