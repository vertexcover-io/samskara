import { describe, expect, test } from "vitest"
import type { NormalizedMessage } from "../../ingest/types.js"
import {
  ASSISTANT_TEXT_EXCERPT_CHARS,
  buildSessionExport,
  REASONING_TEXT_EXCERPT_CHARS,
  USER_TEXT_EXCERPT_CHARS,
} from "./export.js"

const message = (overrides: Partial<Record<string, unknown>> = {}) =>
  ({
    subIndex: 0,
    sessionId: "s1",
    source: "claude_code",
    sourceSchemaVersion: 1,
    trackId: "main",
    msgType: "message",
    role: "user",
    content: { type: "text", value: "fix the build" },
    ...overrides,
  }) as unknown as NormalizedMessage

const toolCall = (callId: string, name: string, overrides: Partial<Record<string, unknown>> = {}) =>
  message({
    subIndex: 1,
    msgType: "toolCall",
    details: { callId, name, input: {} },
    ...overrides,
  })

const toolResult = (
  callId: string,
  status: "success" | "failure" | "cancelled" | "unknown",
  overrides: Partial<Record<string, unknown>> = {},
) =>
  message({
    subIndex: 2,
    msgType: "toolResult",
    details: { callId, output: {}, status },
    ...overrides,
  })

describe("buildSessionExport", () => {
  test("E1: collapses each tool pair into one record and drops turnEvent/custom entirely", () => {
    const messages = [
      message({ subIndex: 0 }),
      toolCall("t1", "Bash", { subIndex: 1 }),
      toolResult("t1", "failure", { subIndex: 2 }),
      message({
        subIndex: 3,
        msgType: "turnEvent",
        details: { type: "unknown", status: "completed" },
      }),
      message({ subIndex: 4, msgType: "compaction", details: { type: "boundary" } }),
      message({ subIndex: 5, msgType: "custom", subType: "step_cost" }),
    ]
    const exported = buildSessionExport({
      sessionId: "s1",
      title: "Fix the build",
      source: "claude_code",
      messages,
    })
    expect(exported.records).toEqual([
      {
        seq: 0,
        id: "msg-0",
        role: "user",
        msgType: "message",
        track: "main",
        text: "fix the build",
      },
      {
        seq: 1,
        id: "msg-1",
        msgType: "toolCall",
        track: "main",
        toolName: "Bash",
        status: "failure",
      },
      { seq: 2, id: "msg-2", msgType: "compaction", track: "main" },
    ])
  })

  test("E11: every record carries ts (epoch ms) from its message timestamp", () => {
    const messages = [
      message({ subIndex: 0, timestamp: "2026-08-25T09:00:00Z" }),
      toolCall("t1", "Bash", {
        subIndex: 1,
        timestamp: "2026-08-25T09:00:10Z",
      }),
      toolResult("t1", "success", { subIndex: 2, timestamp: "2026-08-25T09:00:25Z" }),
    ]
    const { records } = buildSessionExport({
      sessionId: "s1",
      title: "t",
      source: "claude_code",
      messages,
    })
    // The folded toolCall+toolResult keeps the CALL's ts: durations derive from where work
    // started, and the record's identity is the call.
    expect(records.map((record) => record.ts)).toEqual([
      Date.parse("2026-08-25T09:00:00Z"),
      Date.parse("2026-08-25T09:00:10Z"),
    ])
  })

  test("E12: records omit ts when the message carried no timestamp", () => {
    const { records } = buildSessionExport({
      sessionId: "s1",
      title: "t",
      source: "claude_code",
      messages: [message({ subIndex: 0 }), message({ subIndex: 1 })],
    })
    expect(records).toHaveLength(2)
    for (const record of records) expect("ts" in record).toBe(false)
  })

  test("E13: an orphan toolResult carries its own ts; durations stay derivable from seq ranges", () => {
    const { records } = buildSessionExport({
      sessionId: "s1",
      title: "t",
      source: "claude_code",
      messages: [
        message({ subIndex: 0, timestamp: "2026-08-25T09:00:00Z" }),
        toolResult("orphan", "success", {
          subIndex: 1,
          timestamp: "2026-08-25T09:01:00Z",
        }),
      ],
    })
    expect(records[1]).toMatchObject({
      seq: 1,
      id: "msg-1",
      status: "success",
      ts: Date.parse("2026-08-25T09:01:00Z"),
    })
  })

  test("E2: truncates user text to 500, assistant to 300 and reasoning to 200 chars, deterministically", () => {
    const longText = "x".repeat(600)
    const messages = [
      message({ subIndex: 0, role: "user", content: { type: "text", value: longText } }),
      message({
        subIndex: 1,
        role: "assistant",
        content: { type: "text", value: longText },
      }),
      message({
        subIndex: 2,
        role: "assistant",
        content: { type: "reasoning", value: longText },
      }),
      message({ subIndex: 3, role: "system", content: { type: "text", value: longText } }),
    ]
    const { records } = buildSessionExport({
      sessionId: "s1",
      title: "t",
      source: "claude_code",
      messages,
    })
    expect(records[0]?.text).toBe(longText.slice(0, USER_TEXT_EXCERPT_CHARS))
    expect(records[1]?.text).toBe(longText.slice(0, ASSISTANT_TEXT_EXCERPT_CHARS))
    expect(records[2]?.text).toBe(longText.slice(0, REASONING_TEXT_EXCERPT_CHARS))
    expect(records[3]?.text).toBeUndefined()
  })

  test("E3: ids are position-based and unique even when subIndex repeats across tracks", () => {
    const { records, index } = buildSessionExport({
      sessionId: "s1",
      title: "t",
      source: "claude_code",
      messages: [
        message({ subIndex: 6, trackId: "main" }),
        message({ subIndex: 6, trackId: "agent:1" }),
        message({ subIndex: 7, trackId: "agent:1" }),
      ],
    })
    expect(records.map((record) => record.id)).toEqual(["msg-0", "msg-1", "msg-2"])
    // One id per record, no duplicates — a reviewer citing any record's id stays grounded.
    expect(new Set(index.messageIds).size).toBe(3)
  })

  test("E4: collects seqs, messageIds and unique tracks in first-seen order", () => {
    const messages = [
      message({ subIndex: 0 }),
      message({ subIndex: 1, trackId: "agent:sub" }),
      message({ subIndex: 2, trackId: "agent:sub" }),
    ]
    const { index } = buildSessionExport({
      sessionId: "s1",
      title: "t",
      source: "opencode",
      messages,
    })
    expect(index).toEqual({
      seqs: [0, 1, 2],
      messageIds: ["msg-0", "msg-1", "msg-2"],
      tracks: ["main", "agent:sub"],
    })
  })

  test("E5: carries meta through, including optional timestamps", () => {
    const exported = buildSessionExport({
      sessionId: "s1",
      title: "Fix the build",
      source: "claude_code",
      startedAt: "2026-08-25T09:00:00Z",
      endedAt: "2026-08-25T10:30:00Z",
      messages: [message()],
    })
    expect(exported.meta).toEqual({
      sessionId: "s1",
      title: "Fix the build",
      source: "claude_code",
      startedAt: "2026-08-25T09:00:00Z",
      endedAt: "2026-08-25T10:30:00Z",
    })
  })

  test("E6: a toolResult without a matching call carries status but no toolName", () => {
    const { records } = buildSessionExport({
      sessionId: "s1",
      title: "t",
      source: "claude_code",
      messages: [toolResult("orphan", "success", { subIndex: 0 })],
    })
    expect(records[0]).toEqual({
      seq: 0,
      id: "msg-0",
      msgType: "toolResult",
      track: "main",
      status: "success",
    })
  })

  test("E7: is deterministic for the same input", () => {
    const input = {
      sessionId: "s1",
      title: "t",
      source: "claude_code",
      messages: [message(), toolCall("t1", "Bash", { subIndex: 1 })],
    }
    expect(buildSessionExport(input)).toEqual(buildSessionExport(input))
  })

  test("E8: a toolResult folds into its call's record even with messages in between", () => {
    const { records } = buildSessionExport({
      sessionId: "s1",
      title: "t",
      source: "claude_code",
      messages: [
        toolCall("t1", "Read", { subIndex: 0 }),
        message({ subIndex: 1, role: "assistant", content: { type: "text", value: "checking" } }),
        toolResult("t1", "success", { subIndex: 2 }),
      ],
    })
    expect(records).toEqual([
      {
        seq: 0,
        id: "msg-0",
        msgType: "toolCall",
        track: "main",
        toolName: "Read",
        status: "success",
      },
      {
        seq: 1,
        id: "msg-1",
        role: "assistant",
        msgType: "message",
        track: "main",
        text: "checking",
      },
    ])
  })

  test("E9: a duplicate toolResult for the same call is absorbed — first result wins", () => {
    const { records } = buildSessionExport({
      sessionId: "s1",
      title: "t",
      source: "claude_code",
      messages: [
        toolCall("t1", "Bash", { subIndex: 0 }),
        toolResult("t1", "success", { subIndex: 1 }),
        toolResult("t1", "failure", { subIndex: 2 }),
      ],
    })
    expect(records).toEqual([
      {
        seq: 0,
        id: "msg-0",
        msgType: "toolCall",
        track: "main",
        toolName: "Bash",
        status: "success",
      },
    ])
  })

  test("E10: a 1500-message tool-heavy session exports collapsed and bounded", () => {
    const messages: NormalizedMessage[] = []
    for (let turn = 0; turn < 150; turn++) {
      messages.push(
        message({
          subIndex: 0,
          role: "user",
          content: { type: "text", value: `refactor turn ${turn} ${"x".repeat(320)}` },
        }),
        message({
          subIndex: 1,
          role: "assistant",
          content: { type: "text", value: `on it, turn ${turn} ${"y".repeat(140)}` },
        }),
        toolCall(`c${turn}a`, "Bash", { subIndex: 2 }),
        toolResult(`c${turn}a`, "success", { subIndex: 3 }),
        message({
          subIndex: 4,
          msgType: "turnEvent",
          details: { type: "step.end", status: "completed" },
        }),
        toolCall(`c${turn}b`, "Edit", { subIndex: 5 }),
        toolResult(`c${turn}b`, "failure", { subIndex: 6 }),
        message({
          subIndex: 7,
          msgType: "turnEvent",
          details: { type: "step.end", status: "completed" },
        }),
        message({ subIndex: 8, msgType: "custom", subType: "step_cost" }),
        message({
          subIndex: 9,
          msgType: "usage",
          details: { tokens: { input: 100, output: 50, cached: 0, thinking: 0 } },
        }),
      )
    }
    expect(messages).toHaveLength(1500)
    const exported = buildSessionExport({
      sessionId: "s1",
      title: "Big session",
      source: "opencode",
      messages,
    })
    // 1500 messages → 750 records: two tool pairs collapsed per turn, turnEvent/custom gone.
    expect(exported.records).toHaveLength(750)
    expect(exported.records.some((r) => r.msgType === "turnEvent" || r.msgType === "custom")).toBe(
      false,
    )
    expect(exported.index.seqs).toHaveLength(750)
    expect(exported.index.messageIds).toHaveLength(750)
    for (const record of exported.records) {
      if (record.text !== undefined) expect(record.text.length).toBeLessThanOrEqual(150)
    }
    // The whole export, serialized compact, stays well inside the size budget a harness
    // agent can review without paging. (Old shape on this fixture: 1500 records, ~212KB.)
    expect(JSON.stringify(exported).length).toBeLessThan(120_000)
  })
})
