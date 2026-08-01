import { describe, expect, test } from "vitest"
import type { SessionDetailPayload } from "../api/types.js"
import { buildPayload, message } from "../tests/session-fixtures.js"
import { artifactsOf, conversationView, locate, toDetail } from "./records.js"

const kindsOf = (payload: SessionDetailPayload): ReadonlyArray<string> =>
  toDetail(payload).records.map((record) => record.kind)

describe("toDetail", () => {
  test("S38: each msgType maps to its own record kind - a fileEvent artifact never collapses into a generic event", () => {
    const payload = buildPayload({
      messages: [
        message({ lineNumber: 1, msgType: "message", role: "user" }),
        message({ lineNumber: 2, msgType: "message", role: "assistant" }),
        message({ id: "tool-msg", lineNumber: 3, msgType: "toolCall" }),
        message({
          lineNumber: 4,
          msgType: "fileEvent",
          details: { type: "artifact", path: "docs/design.md" },
        }),
        message({ lineNumber: 5, msgType: "systemEvent" }),
      ],
      toolCalls: [
        {
          toolId: "t-1",
          messageId: "tool-msg",
          toolName: "Grep",
          toolInput: { pattern: "x" },
          result: null,
          status: "success",
        },
      ],
    })

    expect(kindsOf(payload)).toEqual(["prompt", "assistant", "tool", "artifact", "event"])
  })

  test("a toolResult message carrying no calls of its own is dropped, not rendered as an empty tool box", () => {
    const payload = buildPayload({
      messages: [
        message({ id: "call-msg", lineNumber: 1, msgType: "toolCall" }),
        message({ id: "result-msg", lineNumber: 2, msgType: "toolResult" }),
      ],
      toolCalls: [
        {
          toolId: "t-1",
          messageId: "call-msg",
          toolName: "Grep",
          toolInput: { pattern: "x" },
          result: { matches: 1 },
          status: "success",
        },
      ],
    })

    expect(kindsOf(payload)).toEqual(["tool"])
  })

  test("S38: a subagent's spawn and return produce agentSpawn and agentReturn records, not two identical events", () => {
    const payload = buildPayload({
      subagents: [
        { agentId: "a1", agentType: "auditor", description: "Audit", parentAgentId: null },
      ],
      messages: [
        message({ lineNumber: 1, msgType: "message", role: "user" }),
        message({ lineNumber: 2, msgType: "turnEvent", subType: "agentSpawn", agentId: "a1" }),
        message({
          lineNumber: 3,
          msgType: "message",
          role: "assistant",
          agentId: "a1",
          isSubagent: true,
        }),
        message({ lineNumber: 4, msgType: "turnEvent", subType: "agentReturn", agentId: "a1" }),
      ],
    })

    expect(kindsOf(payload)).toEqual(["prompt", "agentSpawn", "agentReturn"])
  })

  test("S38: a subagent's own messages are filed under its branch, not left in the main spine", () => {
    const payload = buildPayload({
      subagents: [
        { agentId: "a1", agentType: "auditor", description: "Audit", parentAgentId: null },
      ],
      messages: [
        message({ lineNumber: 1, msgType: "turnEvent", subType: "agentSpawn", agentId: "a1" }),
        message({
          lineNumber: 2,
          msgType: "message",
          role: "user",
          agentId: "a1",
          isSubagent: true,
        }),
        message({
          lineNumber: 3,
          msgType: "message",
          role: "assistant",
          agentId: "a1",
          isSubagent: true,
        }),
      ],
    })

    const detail = toDetail(payload)

    expect(detail.records).toHaveLength(1)
    expect(detail.branches.get("a1")?.map((record) => record.kind)).toEqual(["prompt", "assistant"])
  })

  test("S38: a tool record carries its joined call and result so the renderer never re-joins by hand", () => {
    const payload = buildPayload({
      messages: [message({ id: "m-1", lineNumber: 1, msgType: "toolCall" })],
      toolCalls: [
        {
          toolId: "t-1",
          messageId: "m-1",
          toolName: "Grep",
          toolInput: { pattern: "x" },
          result: { hits: 2 },
          status: "success",
        },
      ],
    })

    const [record] = toDetail(payload).records

    expect(record?.kind).toBe("tool")
    expect(record?.kind === "tool" && record.calls).toEqual([
      {
        toolId: "t-1",
        messageId: "m-1",
        toolName: "Grep",
        toolInput: { pattern: "x" },
        result: { hits: 2 },
        status: "success",
      },
    ])
  })
})

const AGENT = { agentId: "a1", agentType: "auditor", description: "Audit", parentAgentId: null }

// The same run of messages, once for the main spine and once inside a branch: a system event,
// two assistant turns either side of a tool call.
const run = (from: number, agentId: string | null) => {
  const owned = agentId === null ? {} : { agentId, isSubagent: true }
  return [
    message({ id: `sys-${from}`, lineNumber: from, msgType: "systemEvent", ...owned }),
    message({
      id: `say-${from}`,
      lineNumber: from + 1,
      msgType: "message",
      role: "assistant",
      ...owned,
    }),
    message({ id: `call-${from}`, lineNumber: from + 2, msgType: "toolCall", ...owned }),
    message({
      id: `then-${from}`,
      lineNumber: from + 3,
      msgType: "message",
      role: "assistant",
      ...owned,
    }),
  ]
}

const call = (messageId: string) => ({
  toolId: `t-${messageId}`,
  messageId,
  toolName: "Grep",
  toolInput: { pattern: "x" },
  result: { hits: 1 },
  status: "success",
})

const shapedPayload = () =>
  buildPayload({
    subagents: [AGENT],
    messages: [
      ...run(1, null),
      message({
        id: "spawn-msg",
        lineNumber: 5,
        msgType: "turnEvent",
        subType: "agentSpawn",
        agentId: "a1",
      }),
      ...run(6, "a1"),
    ],
    toolCalls: [call("call-1"), call("call-6")],
  })

describe("conversationView", () => {
  test("S56: a branch is shaped exactly like the main spine - its system events are dropped and its assistant run merges into one block", () => {
    const view = conversationView(toDetail(shapedPayload()), false)

    expect(view.records.map((record) => record.kind)).toEqual(["assistant", "agentSpawn"])
    expect(view.branches.get("a1")?.map((record) => record.kind)).toEqual(["assistant"])
  })

  test("S57: a merged block claims every message folded into it, so the ids the merge swallowed stay addressable", () => {
    const view = conversationView(toDetail(shapedPayload()), false)

    expect(view.records[0]?.sources).toEqual(["say-1", "then-1"])
    expect(view.branches.get("a1")?.[0]?.sources).toEqual(["say-6", "then-6"])
  })

  test("S58: a spawn marker synthesised from an Agent tool call claims no messages, so the call it was built from stays owned by the tool record alone", () => {
    const payload = buildPayload({
      subagents: [AGENT],
      messages: [message({ id: "agent-call", lineNumber: 1, msgType: "toolCall" })],
      toolCalls: [{ ...call("agent-call"), toolName: "Agent" }],
    })

    const view = conversationView(toDetail(payload), true)

    expect(view.records.map((record) => record.kind)).toEqual(["tool", "agentSpawn"])
    expect(view.records[0]?.sources).toEqual(["agent-call"])
    expect(view.records[1]?.sources).toEqual([])
  })
})

// A branch can spawn its own branches. Its marker belongs on the track that launched it -- the
// parent's, not the main spine's -- or the agent is listed in the rail with nothing to open.
test("S76: an agent spawned by another agent gets its marker inside the parent's branch, so a nested branch is reachable rather than orphaned", () => {
  const payload = buildPayload({
    subagents: [
      { agentId: "a1", agentType: "explorer", description: "Top", parentAgentId: null },
      { agentId: "a2", agentType: "explorer", description: "Nested", parentAgentId: "a1" },
    ],
    messages: [
      message({ id: "top-call", lineNumber: 1, msgType: "toolCall" }),
      message({
        id: "nested-call",
        lineNumber: 2,
        msgType: "toolCall",
        agentId: "a1",
        isSubagent: true,
      }),
      message({
        id: "nested-say",
        lineNumber: 3,
        msgType: "message",
        role: "assistant",
        agentId: "a2",
        isSubagent: true,
      }),
    ],
    toolCalls: [
      { ...call("top-call"), toolName: "Agent" },
      { ...call("nested-call"), toolName: "Agent" },
    ],
  })

  const detail = toDetail(payload)

  expect(detail.records.map((record) => record.kind)).toEqual(["tool", "agentSpawn"])
  expect(detail.branches.get("a1")?.map((record) => record.kind)).toEqual(["tool", "agentSpawn"])
  expect(detail.branches.get("a2")?.map((record) => record.kind)).toEqual(["assistant"])
})

describe("locate", () => {
  test("S59: a message the merge swallowed resolves to the block that renders it, and a branch message names the agent whose annex holds it", () => {
    const sites = locate(conversationView(toDetail(shapedPayload()), false))

    expect(sites.get("say-1")).toEqual({ agentId: null, anchor: "r-say-1" })
    expect(sites.get("then-1")).toEqual({ agentId: null, anchor: "r-say-1" })
    expect(sites.get("then-6")).toEqual({ agentId: "a1", anchor: "r-say-6" })
    expect(sites.get("spawn-msg")).toEqual({ agentId: null, anchor: "spawn-a1" })
  })

  test("S60: a message resolves in both inline-tool modes even though the tool call splits the block in one of them", () => {
    const detail = toDetail(shapedPayload())

    expect(locate(conversationView(detail, false)).get("then-6")?.anchor).toBe("r-say-6")
    expect(locate(conversationView(detail, true)).get("then-6")?.anchor).toBe("r-then-6")
  })
})

describe("artifactsOf", () => {
  test("S38: artifacts are derived from fileEvent messages whose details.type is artifact - other fileEvents are excluded", () => {
    const payload = buildPayload({
      messages: [
        message({
          lineNumber: 1,
          msgType: "fileEvent",
          details: { type: "artifact", path: "docs/design.md", title: "Design" },
        }),
        message({
          lineNumber: 2,
          msgType: "fileEvent",
          details: { type: "read", path: "src/x.ts" },
        }),
        message({ lineNumber: 3, msgType: "message", role: "assistant" }),
      ],
    })

    const artifacts = artifactsOf(toDetail(payload).records)

    expect(artifacts).toHaveLength(1)
    expect(artifacts[0]).toMatchObject({ path: "docs/design.md", title: "Design" })
  })

  test("S38: an artifact with neither path nor url still lists, labelled by its fallback title rather than dropped", () => {
    const payload = buildPayload({
      messages: [message({ lineNumber: 1, msgType: "fileEvent", details: { type: "artifact" } })],
    })

    const artifacts = artifactsOf(toDetail(payload).records)

    expect(artifacts).toHaveLength(1)
    expect(artifacts[0]?.path).toBeNull()
    expect(artifacts[0]?.url).toBeNull()
  })
})
