import { describe, expect, test } from "vitest"
import type { SessionDetailPayload } from "../api/types.js"
import { buildPayload, message, pastedImage } from "../tests/session-fixtures.js"
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

  test("a user turn the harness injected reads as an injection, never as a prompt the user typed", () => {
    const payload = buildPayload({
      messages: [
        message({ lineNumber: 1, msgType: "message", role: "user", subType: "compactSummary" }),
        message({ lineNumber: 2, msgType: "message", role: "user", subType: "taskNotification" }),
        message({ lineNumber: 3, msgType: "message", role: "user", subType: "systemReminder" }),
        message({ lineNumber: 4, msgType: "message", role: "user", subType: "localCommand" }),
        message({ lineNumber: 5, msgType: "message", role: "user" }),
      ],
    })

    expect(kindsOf(payload)).toEqual(["injection", "injection", "injection", "injection", "prompt"])
  })

  test("an injection is labelled by what put it there, and a skill body names the skill", () => {
    const payload = buildPayload({
      messages: [
        message({
          lineNumber: 1,
          msgType: "message",
          role: "user",
          subType: "toolInjection",
          content: {
            type: "text",
            value: "Base directory for this skill: /Users/maya/skills/orchestrate\n\n# Orchestrate",
          },
        }),
        message({
          lineNumber: 2,
          msgType: "message",
          role: "user",
          subType: "toolInjection",
          content: { type: "text", value: "some other tool output" },
        }),
        message({ lineNumber: 3, msgType: "message", role: "user", subType: "compactSummary" }),
      ],
    })

    expect(
      toDetail(payload).records.map((record) =>
        record.kind === "injection" ? record.label : record.kind,
      ),
    ).toEqual(["Skill Loaded — orchestrate", "Tool Injection", "Context Continued"])
  })

  test("an unrecognised subType on a user turn is still a prompt - an unknown marker never hides what was said", () => {
    const payload = buildPayload({
      messages: [
        message({ lineNumber: 1, msgType: "message", role: "user", subType: "somethingNew" }),
      ],
    })

    expect(kindsOf(payload)).toEqual(["prompt"])
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

  test("S59: a branch whose spawning call was never captured still gets a marker, so its messages stay reachable", () => {
    // Observed live: a session held four subagent rows but only three Agent calls on the spine.
    // Positional pairing shifted the queue three times and the surplus branch fell out of the
    // timeline entirely -- its messages were in the database with nothing able to reach them.
    const payload = buildPayload({
      subagents: [
        AGENT,
        { agentId: "a2", agentType: "auditor", description: null, parentAgentId: null },
      ],
      messages: [
        message({ id: "agent-call", lineNumber: 1, msgType: "toolCall" }),
        message({
          lineNumber: 2,
          msgType: "message",
          role: "assistant",
          agentId: "a2",
          isSubagent: true,
        }),
      ],
      toolCalls: [{ ...call("agent-call"), toolName: "Agent" }],
    })

    const view = conversationView(toDetail(payload), true)
    const spawned = view.records
      .filter((record) => record.kind === "agentSpawn")
      .map((record) => (record.kind === "agentSpawn" ? record.agent.agentId : null))

    expect(spawned).toEqual(["a1", "a2"])
    expect(view.branches.get("a2")).toHaveLength(1)
  })
})

// One transcript line whose content array holds several blocks is captured as one row per block,
// so a pasted screenshot arrives beside the text it was pasted with rather than inside it.
describe("prompt turns", () => {
  const PNG = "iVBORw0KGgoAAAANSUhEUg=="

  const pastedTurn = (): SessionDetailPayload =>
    buildPayload({
      messages: [
        message({
          id: "ask-text",
          lineNumber: 9,
          msgType: "message",
          role: "user",
          content: { type: "text", value: "Remove the model chip" },
        }),
        message({
          id: "ask-image",
          lineNumber: 9,
          msgType: "message",
          role: "user",
          content: pastedImage(PNG),
        }),
      ],
    })

  const promptAt = (payload: SessionDetailPayload, index = 0) => {
    const record = conversationView(toDetail(payload), true).records[index]
    if (record?.kind !== "prompt") throw new Error(`record ${index} is not a prompt`)
    return record
  }

  test("the blocks of one prompt merge into a single record instead of one bubble per block", () => {
    expect(conversationView(toDetail(pastedTurn()), true).records.map((r) => r.kind)).toEqual([
      "prompt",
    ])
  })

  test("a pasted image becomes an image part addressed by data URI, never its base64 as prose", () => {
    const record = promptAt(pastedTurn())

    expect(record.parts).toEqual([
      { id: "ask-text:0", kind: "text", value: "Remove the model chip" },
      { id: "ask-image:0", kind: "image", src: `data:image/png;base64,${PNG}` },
    ])
    expect(record.parts.some((part) => part.kind === "text" && part.value.includes(PNG))).toBe(
      false,
    )
  })

  test("prompts on separate lines are separate turns, however adjacent they render", () => {
    const payload = buildPayload({
      messages: [
        message({
          lineNumber: 9,
          msgType: "message",
          role: "user",
          content: { type: "text", value: "first" },
        }),
        message({
          lineNumber: 14,
          msgType: "message",
          role: "user",
          content: { type: "text", value: "second" },
        }),
      ],
    })

    expect(conversationView(toDetail(payload), true).records.map((r) => r.kind)).toEqual([
      "prompt",
      "prompt",
    ])
  })

  test("a merged prompt claims every block it swallowed, so a permalink to either one resolves", () => {
    const sites = locate(conversationView(toDetail(pastedTurn()), true))

    expect(sites.get("ask-text")).toEqual({ agentId: null, anchor: "r-ask-text" })
    expect(sites.get("ask-image")).toEqual({ agentId: null, anchor: "r-ask-text" })
  })

  test("an image block with no encoding to resolve is dropped rather than spilled as base64 text", () => {
    const payload = buildPayload({
      messages: [
        message({
          id: "ask-image",
          lineNumber: 9,
          msgType: "message",
          role: "user",
          content: { type: "image", value: PNG },
        }),
      ],
    })

    expect(promptAt(payload).parts).toEqual([])
  })

  test("a user turn on a branch merges against that branch, not the prompt above it on the spine", () => {
    const payload = buildPayload({
      subagents: [
        { agentId: "a1", agentType: "auditor", description: "Audit", parentAgentId: null },
      ],
      messages: [
        message({
          id: "spine-ask",
          lineNumber: 9,
          msgType: "message",
          role: "user",
          content: { type: "text", value: "spine" },
        }),
        message({
          id: "branch-ask",
          lineNumber: 9,
          msgType: "message",
          role: "user",
          agentId: "a1",
          isSubagent: true,
          content: { type: "text", value: "branch" },
        }),
      ],
    })

    const view = conversationView(toDetail(payload), true)

    // The spawn marker trails the prompt because this fixture's branch has no Agent call to pair
    // with, so it is surfaced as an unspawned branch rather than dropped.
    expect(view.records.map((r) => r.kind)).toEqual(["prompt", "agentSpawn"])
    expect(view.records[0]?.sources).toEqual(["spine-ask"])
    expect(view.branches.get("a1")?.[0]?.sources).toEqual(["branch-ask"])
  })
})

// Capture stores an assistant turn's thinking as a `reasoning` block. Encrypted thinking arrives
// as a signature with no text at all, which is every reasoning block this project has captured.
describe("reasoning blocks", () => {
  const assistantAt = (content: unknown, index = 0) => {
    const payload = buildPayload({
      messages: [message({ lineNumber: 1, msgType: "message", role: "assistant", content })],
    })
    const record = toDetail(payload).records[index]
    if (record?.kind !== "assistant") throw new Error(`record ${index} is not an assistant`)
    return record
  }

  test("reasoning text is disclosed as thinking, never as the answer's prose", () => {
    const record = assistantAt({ type: "reasoning", value: "Weighing the upsert", signature: "s" })

    expect(record.thinking).toBe("Weighing the upsert")
    expect(record.body).toBe("")
  })

  test("reasoning alongside prose keeps the two apart rather than concatenating them", () => {
    const record = assistantAt([
      { type: "reasoning", value: "Weighing the upsert" },
      { type: "text", value: "Here is the plan" },
    ])

    expect(record.thinking).toBe("Weighing the upsert")
    expect(record.body).toBe("Here is the plan")
  })

  test("encrypted reasoning holds a signature and no text, so it discloses nothing", () => {
    const record = assistantAt({ type: "reasoning", value: "", signature: "sig" })

    expect(record.thinking).toBeNull()
    expect(record.body).toBe("")
  })
})

// A slash command is the one thing in the transcript the user definitely typed. It arrives as a
// localCommand, which used to shape as an event and be dropped along with the hooks and snapshots.
describe("slash commands", () => {
  const commandView = (details: unknown) =>
    conversationView(
      toDetail(
        buildPayload({ messages: [message({ lineNumber: 1, msgType: "localCommand", details })] }),
      ),
      true,
    ).records

  test("an invocation survives the shaping that drops events, carrying what was typed with it", () => {
    const [record] = commandView({
      command: "/orchestrate",
      commandType: "slash",
      args: "Capture files the agent wrote",
    })

    expect(record?.kind).toBe("command")
    expect(record).toMatchObject({
      command: "/orchestrate",
      args: "Capture files the agent wrote",
    })
  })

  test("a bare command still marks where it ran, with nothing claimed for its arguments", () => {
    const [record] = commandView({ command: "/clear", commandType: "slash" })

    expect(record?.kind).toBe("command")
    expect(record).toMatchObject({ command: "/clear", args: "" })
  })

  test("a local command naming no command of its own stays an event, so stdout rows keep out", () => {
    expect(commandView({ stdout: "Set model to Opus", commandType: "unknown" })).toEqual([])
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
