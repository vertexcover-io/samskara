import { describe, expect, test } from "vitest"
import type { SessionDetailPayload } from "../api/types.js"
import { buildPayload, message } from "../tests/session-fixtures.js"
import { artifactsOf, toDetail } from "./records.js"

const kindsOf = (payload: SessionDetailPayload): ReadonlyArray<string> =>
  toDetail(payload).records.map((record) => record.kind)

describe("toDetail", () => {
  test("S38: each msgType maps to its own record kind - a fileEvent artifact never collapses into a generic event", () => {
    const payload = buildPayload({
      messages: [
        message({ lineNumber: 1, msgType: "message", role: "user" }),
        message({ lineNumber: 2, msgType: "message", role: "assistant" }),
        message({ lineNumber: 3, msgType: "toolCall" }),
        message({
          lineNumber: 4,
          msgType: "fileEvent",
          details: { type: "artifact", path: "docs/design.md" },
        }),
        message({ lineNumber: 5, msgType: "systemEvent" }),
      ],
    })

    expect(kindsOf(payload)).toEqual(["prompt", "assistant", "tool", "artifact", "event"])
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
