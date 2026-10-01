import { describe, expect, test } from "vitest"
import type { SessionExportRecord } from "../lenses/export.js"
import { findLeads } from "./leads.js"

const MIN = 60_000
const rec = (seq: number, fields: Partial<SessionExportRecord>): SessionExportRecord => ({
  seq,
  id: `msg-${seq}`,
  msgType: "message",
  track: "main",
  ts: seq * 1000,
  ...fields,
})

describe("findLeads", () => {
  test("L1: human messages, interrupts and questions the agent asked are listed, each with its own lead id", () => {
    const { markdown, ids } = findLeads([
      rec(0, { role: "user", text: "build the pricing page" }),
      rec(1, { role: "assistant", text: "Which plan should be the default?" }),
      rec(2, { msgType: "toolCall", toolName: "AskUserQuestion", input: '{"q":"FREE or PRO?"}' }),
      rec(3, { role: "user", text: "[Request interrupted by user]" }),
    ])
    expect(markdown).toContain("## Human messages\n\n- L1 msg-0: build the pricing page")
    expect(markdown).toContain("## Interrupts\n\n- L2 msg-3")
    expect(markdown).toContain("- L3 msg-1: Which plan should be the default?")
    expect(markdown).toContain("- L4 msg-2: AskUserQuestion")
    expect(ids).toEqual(["L1", "L2", "L3", "L4"])
  })

  test("L1b: the person's messages are named as such, with the message each points to", () => {
    const { humanLeads } = findLeads([
      rec(0, { role: "user", text: "build the pricing page" }),
      rec(1, { role: "assistant", text: "Which plan should be the default?" }),
      rec(2, { role: "user", text: "use fence for the list instead" }),
    ])
    expect(humanLeads).toEqual([
      { id: "L1", msgId: "msg-0" },
      { id: "L2", msgId: "msg-2" },
    ])
  })

  test("L2: a helper's instructions are not a human message — only the main track's are", () => {
    const { markdown } = findLeads([
      rec(0, { role: "user", text: "the person asks" }),
      rec(1, { role: "user", text: "Implement phase 2 of the plan", track: "agent-abc" }),
    ])
    expect(markdown).toContain("msg-0: the person asks")
    expect(markdown).not.toContain("Implement phase 2")
  })

  test("L3: failures are listed, and three of one tool are called out as a cluster", () => {
    const fail = (seq: number) =>
      rec(seq, {
        msgType: "toolCall",
        toolName: "Bash",
        status: "failure",
        input: `{"command":"bun test ${seq}"}`,
      })
    const { markdown } = findLeads([fail(0), fail(1), fail(2)])
    expect(markdown).toContain("## Tool failures")
    expect(markdown).toContain("- L1 Bash failed 3 times: msg-0, msg-1, msg-2")
    expect(markdown).toContain('- L2 msg-0: Bash {"command":"bun test 0"}')
  })

  test("L4: the same call three or more times is a repeat, whatever its status", () => {
    const same = (seq: number) =>
      rec(seq, {
        msgType: "toolCall",
        toolName: "Bash",
        status: "success",
        input: '{"command":"curl localhost:7100"}',
      })
    const { markdown } = findLeads([same(0), same(1), same(2)])
    expect(markdown).toContain(
      '- L1 Bash ×3: msg-0, msg-1, msg-2 — {"command":"curl localhost:7100"}',
    )
  })

  test("L5: a gap over five minutes is labelled by what ends it", () => {
    const { markdown } = findLeads([
      rec(0, { role: "assistant", text: "Shall I go on.", ts: 0 }),
      rec(1, { role: "user", text: "yes", ts: 20 * MIN }),
      rec(2, { msgType: "toolCall", toolName: "Bash", ts: 21 * MIN }),
      rec(3, { msgType: "toolCall", toolName: "Bash", ts: 40 * MIN }),
    ])
    expect(markdown).toContain("msg-0 to msg-1: 20m, waiting for the person")
    expect(markdown).toContain("msg-2 to msg-3: 19m, nothing running — check it")
  })

  test("L6: gaps are measured in time order, so helper tracks stored apart do not make false gaps", () => {
    // Stored track by track: the main track, then a helper that ran in between.
    const { markdown } = findLeads([
      rec(0, { role: "user", text: "go", ts: 0 }),
      rec(1, { role: "assistant", text: "done", ts: 10 * MIN }),
      rec(2, { role: "assistant", text: "helper step", track: "agent-a", ts: 3 * MIN }),
      rec(3, { role: "assistant", text: "helper step", track: "agent-a", ts: 6 * MIN }),
    ])
    expect(markdown).not.toContain("Gaps over 5 minutes")
  })

  test("L7: a quiet session says so rather than printing empty headings", () => {
    const { markdown, ids } = findLeads([rec(0, { role: "assistant", text: "done" })])
    expect(markdown).toContain("No leads found")
    expect(ids).toEqual([])
  })

  test("L8: only messages the person typed are human; notices, reminders and injected skills are not", () => {
    const { markdown } = findLeads([
      rec(0, { role: "user", text: "the person", origin: "human" }),
      rec(1, { role: "user", text: "<task-notification> done", origin: "task-notification" }),
      rec(2, { role: "user", text: "Base directory for this skill", origin: "toolInjection" }),
      rec(3, { role: "user", text: "typed, no mark" }),
    ])
    expect(markdown).toContain("msg-0: the person")
    expect(markdown).toContain("msg-3: typed, no mark")
    expect(markdown).not.toContain("task-notification")
    expect(markdown).not.toContain("Base directory")
  })

  test("L9: a question-box lead shows what the person answered", () => {
    const { markdown } = findLeads([
      rec(0, {
        msgType: "toolCall",
        toolName: "AskUserQuestion",
        input: "{}",
        output: 'The user answered: "Approve?"="not ablr to see design, phases"',
      }),
    ])
    expect(markdown).toContain(
      'msg-0: AskUserQuestion → The user answered: "Approve?"="not ablr to see design, phases"',
    )
  })

  test("L9b: a question tool is found whatever its case, as the reader shortening finds it", () => {
    const { markdown } = findLeads([
      rec(0, { msgType: "toolCall", toolName: "askuserquestion", input: "{}", output: "PRO" }),
    ])
    expect(markdown).toContain("msg-0: askuserquestion → PRO")
  })

  test("L10: leads the readers found come first, each with its own id, words and reason", () => {
    const { markdown, ids } = findLeads(
      [rec(0, { role: "user", text: "go" })],
      [
        {
          from: "msg-4",
          to: "msg-6",
          quote: "all tests pass",
          why: "no test ran",
          piece: "main, part 1",
        },
      ],
    )
    expect(markdown).toContain(
      '## Found by reading\n\n- L1 msg-4 to msg-6: "all tests pass" — no test ran (main, part 1)',
    )
    expect(markdown).toContain("## Human messages\n\n- L2 msg-0: go")
    expect(ids).toEqual(["L1", "L2"])
  })
})
