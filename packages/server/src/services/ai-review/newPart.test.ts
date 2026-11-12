import { describe, expect, test } from "vitest"
import { splitNewPart } from "./newPart.js"

const finishedAt = new Date("2026-01-01T10:30:00.000Z")
const boundary = { after: "2026-01-01T10:00:00.000Z", finishedAt }

const at = (
  id: string,
  timestamp: string | null,
  extra: { msgType?: string; createdAt?: string; details?: unknown } = {},
) => ({
  id,
  msgType: extra.msgType ?? "message",
  timestamp,
  createdAt: extra.createdAt ?? "2026-01-01T10:00:00.000Z",
  details: extra.details ?? {},
})

const ids = (messages: ReadonlyArray<{ readonly id: string }>) => messages.map((m) => m.id)

describe("splitNewPart", () => {
  test("SC12: messages later than 10:00 in any track, and untimed ones stored after the base finished, are fresh; the rest stay earlier", () => {
    const messages = [
      at("main-0959", "2026-01-01T09:59:00.000Z"),
      at("main-1000", "2026-01-01T10:00:00.000Z"),
      at("main-1001", "2026-01-01T10:01:00.000Z"),
      at("sub-1002", "2026-01-01T10:02:00.000Z"),
      at("untimed-late", null, { createdAt: "2026-01-01T10:31:00.000Z" }),
      at("untimed-early", null, { createdAt: "2026-01-01T10:29:00.000Z" }),
    ]

    const { earlier, fresh } = splitNewPart(messages, boundary)

    expect(ids(fresh)).toEqual(["main-1001", "sub-1002", "untimed-late"])
    expect(ids(earlier)).toEqual(["main-0959", "main-1000", "untimed-early"])
  })

  test("SC13: a tool call read at 09:58 before its result is read again once the result arrives at 10:03", () => {
    const messages = [
      at("call", "2026-01-01T09:58:00.000Z", { msgType: "toolCall", details: { callId: "c1" } }),
      at("other-call", "2026-01-01T09:58:30.000Z", {
        msgType: "toolCall",
        details: { callId: "c0" },
      }),
      at("result", "2026-01-01T10:03:00.000Z", {
        msgType: "toolResult",
        details: { callId: "c1" },
      }),
    ]

    const { earlier, fresh } = splitNewPart(messages, boundary)

    expect(ids(fresh)).toEqual(["call", "result"])
    expect(ids(earlier)).toEqual(["other-call"])
  })

  test.each(["usage", "turnEvent", "custom"])(
    "a %s message after 10:00 is never fresh, the same rule the new-messages check uses",
    (msgType) => {
      const messages = [
        at("silent", "2026-01-01T10:05:00.000Z", { msgType }),
        at("untimed-silent", null, { msgType, createdAt: "2026-01-01T10:31:00.000Z" }),
        at("real", "2026-01-01T10:06:00.000Z"),
      ]

      const { earlier, fresh } = splitNewPart(messages, boundary)

      expect(ids(fresh)).toEqual(["real"])
      expect(ids(earlier)).toEqual(["silent", "untimed-silent"])
    },
  )

  test("a base run that read nothing makes every timed message fresh", () => {
    const { earlier, fresh } = splitNewPart([at("a", "2026-01-01T08:00:00.000Z")], {
      after: null,
      finishedAt,
    })
    expect(ids(fresh)).toEqual(["a"])
    expect(earlier).toEqual([])
  })
})
