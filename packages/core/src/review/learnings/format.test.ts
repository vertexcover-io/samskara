import { describe, expect, test } from "vitest"
import {
  groupsForWriter,
  knownLearningsMd,
  parseGroupsMd,
  parseWrittenMd,
  problemsMd,
} from "./format.js"
import type { LearningInput, ProblemInput } from "./types.js"

const problem = (id: string, fields: Partial<ProblemInput> = {}): ProblemInput => ({
  id,
  sessionId: `session-${id}`,
  title: `Problem ${id}`,
  class: "slow",
  severity: "medium",
  severityReason: "lost time",
  fixType: "skill",
  description: "Expected a wait. It returned early.",
  learning: "Wait for the run to finish.",
  evidence: [{ from: "msg-1", to: "msg-1", quote: "waiting on jest", why: "returned early" }],
  ...fields,
})

/** Rules and limits loose enough not to matter, for tests about something else. */
const ANY = { joined: [], maxHigh: 99, maxMedium: 99 }
const ROOM = { high: 99, medium: 99 }

const FIX_TYPES = ["skill", "code", "project_guidelines", "knowledge_base", "human"]

describe("what agent 1 reads", () => {
  test("LF1: each problem gets a short id and every field the grouping needs, quotes but no ids", () => {
    const md = problemsMd([problem("a", { title: "Returned while jest ran" })])
    expect(md).toContain("## P1")
    expect(md).toContain("- **Title:** Returned while jest ran")
    expect(md).toContain("- **Class:** slow")
    expect(md).toContain("- **Severity:** medium — lost time")
    expect(md).toContain("- **Learning:** Wait for the run to finish.")
    expect(md).toContain('"waiting on jest"')
    expect(md).not.toContain("msg-1")
  })

  test("LF2: existing learnings are listed by short id with their title and cause", () => {
    const md = knownLearningsMd([{ id: "x", title: "Agents return early", cause: "No wait rule." }])
    expect(md).toContain("## K1: Agents return early")
    expect(md).toContain("Cause: No wait rule.")
  })

  test("LF3: with no existing learnings, the file says so", () => {
    expect(knownLearningsMd([])).toContain("None yet")
  })
})

describe("reading agent 1's groups", () => {
  const groups = `# Groups

## Agents stop before background runs finish
- **Joins:** K1
- **Cause:** No rule tells helpers to wait for a run to exit.
- **Problems:** P1, P3

## Fake data in checks
- **Joins:** new
- **Cause:** The verify step allows mocks.
- **Problems:** P2
`

  test("LG1: a well-formed file gives one group per heading", () => {
    const parsed = parseGroupsMd(groups, ["P1", "P2", "P3"], ["K1"])
    expect(parsed.errors).toEqual([])
    expect(parsed.groups).toEqual([
      {
        name: "Agents stop before background runs finish",
        joins: "K1",
        cause: "No rule tells helpers to wait for a run to exit.",
        problems: ["P1", "P3"],
      },
      {
        name: "Fake data in checks",
        joins: null,
        cause: "The verify step allows mocks.",
        problems: ["P2"],
      },
    ])
  })

  test("LG2: a problem left out, placed twice, or made up is an error", () => {
    const parsed = parseGroupsMd(groups.replace("P1, P3", "P1, P2, P9"), ["P1", "P2", "P3"], ["K1"])
    expect(parsed.errors.join("\n")).toMatch(/P2 is in more than one group/)
    expect(parsed.errors.join("\n")).toMatch(/P9 is not a problem id/)
    expect(parsed.errors.join("\n")).toMatch(/Not in any group: P3/)
  })

  test("LG3: joining a learning that does not exist, or the same one twice, is an error", () => {
    const twice = parseGroupsMd(
      groups.replace("- **Joins:** new", "- **Joins:** K1"),
      ["P1", "P2", "P3"],
      ["K1"],
    )
    expect(twice.errors.join("\n")).toMatch(/K1 is joined by more than one group/)
    const unknown = parseGroupsMd(groups, ["P1", "P2", "P3"], [])
    expect(unknown.errors.join("\n")).toMatch(/K1 is not a learning id/)
  })

  test("LG4: a group with no cause or no problems is an error", () => {
    const parsed = parseGroupsMd(
      "## A\n- **Joins:** new\n- **Problems:** P1\n\n## B\n- **Joins:** new\n- **Cause:** x\n",
      ["P1"],
      [],
    )
    expect(parsed.errors.join("\n")).toMatch(/"A" has no Cause/)
    expect(parsed.errors.join("\n")).toMatch(/"B" has no Problems/)
  })

  test("LG5: a field can run over more than one line", () => {
    const parsed = parseGroupsMd(
      "## A\n- **Joins:** new\n- **Cause:** first line\n  second line\n- **Problems:** P1\n",
      ["P1"],
      [],
    )
    expect(parsed.groups[0]?.cause).toBe("first line second line")
  })
})

describe("what agent 2 reads and writes", () => {
  const existing: LearningInput = {
    id: "k",
    title: "Agents return early",
    cause: "No wait rule.",
    problem: "Helpers stop before jest exits.",
    priority: "medium",
    priorityReason: "Two sessions.",
    fixType: "skill",
    fix: "Add a wait rule to skills/implement/SKILL.md.",
  }

  test("LW1: each group shows its cause, the learning it joins, the counts, and every problem", () => {
    const md = groupsForWriter(
      [
        {
          id: "G1",
          cause: "No wait rule.",
          existing,
          problems: [
            problem("a", { severity: "high", class: "missed" }),
            problem("b", { sessionId: "session-a" }),
            problem("c"),
          ],
        },
      ],
      ROOM,
    )
    expect(md).toContain("## G1")
    expect(md).toContain("- **Cause:** No wait rule.")
    expect(md).toContain("Agents return early")
    expect(md).toContain("Add a wait rule to skills/implement/SKILL.md.")
    expect(md).toContain("3 problems in 2 sessions")
    expect(md).toContain("severity: 1 high, 2 medium, 0 low")
    expect(md).toContain("class: 1 missed, 0 blocked, 2 slow, 0 caught")
  })

  const written = `## G1
- **Verdict:** learning
- **Title:** Helpers stop before background runs finish
- **Problem:** Coder agents report while jest still runs, so the orchestrator chases them.
- **Priority:** high — 3 sessions, and one shipped a wrong result
- **Fix type:** skill
- **Fix:** In skills/implement/SKILL.md, add: wait for the run to exit before reporting.

## G2
- **Verdict:** drop
- **Why:** One session, medium and slow, a one-off typo.
`

  test("LW2: a learning and a drop are both read back", () => {
    const parsed = parseWrittenMd(written, ["G1", "G2"], FIX_TYPES, ANY)
    expect(parsed.errors).toEqual([])
    expect(parsed.answers.G1).toEqual({
      verdict: "learning",
      title: "Helpers stop before background runs finish",
      problem: "Coder agents report while jest still runs, so the orchestrator chases them.",
      priority: "high",
      priorityReason: "3 sessions, and one shipped a wrong result",
      fixType: "skill",
      fix: "In skills/implement/SKILL.md, add: wait for the run to exit before reporting.",
    })
    expect(parsed.answers.G2).toEqual({
      verdict: "drop",
      reason: "One session, medium and slow, a one-off typo.",
    })
  })

  test("LW3: a group left unanswered, a bad priority, or a fix type outside the list is an error", () => {
    const parsed = parseWrittenMd(
      written.replace("high —", "urgent —").replace("Fix type:** skill", "Fix type:** prompts"),
      ["G1", "G2", "G3"],
      FIX_TYPES,
      ANY,
    )
    const errors = parsed.errors.join("\n")
    expect(errors).toMatch(/Not answered: G3/)
    expect(errors).toMatch(/G1: Priority must be high, medium or low/)
    expect(errors).toMatch(/G1: Fix type must be one of/)
  })

  test("LW4: a group that updates an existing learning cannot be dropped", () => {
    const parsed = parseWrittenMd(
      "## G1\n- **Verdict:** drop\n- **Why:** one-off\n",
      ["G1"],
      FIX_TYPES,
      { joined: ["G1"], maxHigh: 5, maxMedium: 8 },
    )
    expect(parsed.errors.join("\n")).toMatch(/G1: it updates an existing learning/)
  })

  test("LW5: new learnings over the high limit fail; updated ones do not count", () => {
    const high = (id: string) =>
      `## ${id}\n- **Verdict:** learning\n- **Title:** t\n- **Problem:** p\n- **Priority:** high — why\n- **Fix type:** skill\n- **Fix:** f\n`
    const md = ["G1", "G2", "G3"].map(high).join("\n")
    const over = parseWrittenMd(md, ["G1", "G2", "G3"], FIX_TYPES, {
      joined: [],
      maxHigh: 2,
      maxMedium: 8,
    })
    expect(over.errors.join("\n")).toMatch(/3 new learnings are high \(G1, G2, G3\).*at most 2/)
    const updated = parseWrittenMd(md, ["G1", "G2", "G3"], FIX_TYPES, {
      joined: ["G3"],
      maxHigh: 2,
      maxMedium: 8,
    })
    expect(updated.errors).toEqual([])
  })

  test("LW6: agent 2's file says how many high and medium this batch may still make", () => {
    const md = groupsForWriter(
      [{ id: "G1", cause: "x", existing: null, problems: [problem("a")] }],
      {
        high: 2,
        medium: 8,
      },
    )
    expect(md).toContain("at most 2 new high-priority and 8 new medium-priority learnings")
  })

  test("LW7: a drop needs one sentence why, and is read back", () => {
    const parsed = parseWrittenMd(
      "## G1\n- **Verdict:** drop\n- **Why:** One session, medium and slow, nothing makes it recur.\n\n## G2\n- **Verdict:** drop\n",
      ["G1", "G2"],
      FIX_TYPES,
      ANY,
    )
    expect(parsed.answers.G1).toEqual({
      verdict: "drop",
      reason: "One session, medium and slow, nothing makes it recur.",
    })
    expect(parsed.errors.join("\n")).toMatch(/G2: a drop needs - \*\*Why:\*\*/)
  })

  test("LW8: a new problem's excerpt is shown under it; a problem without one shows none", () => {
    const md = groupsForWriter(
      [
        {
          id: "G1",
          cause: "x",
          existing: null,
          problems: [
            problem("old"),
            problem("new", {
              excerpt:
                'msg-4 — "waiting on jest" — returned early\n\n[msg-4] assistant:\nwaiting on jest',
            }),
          ],
        },
      ],
      ROOM,
    )
    expect(md).toContain("Evidence, with the session around it:")
    expect(md).toContain('    msg-4 — "waiting on jest" — returned early')
    expect(md.match(/Evidence, with the session around it/g)).toHaveLength(1)
  })

  test("LW9: a learning with many problems lists only the newest, but counts them all", () => {
    const many = Array.from({ length: 35 }, (_, index) =>
      problem(`p${index}`, { title: `Problem number ${index}` }),
    )
    const md = groupsForWriter([{ id: "G1", cause: "x", existing: null, problems: many }], ROOM)
    expect(md).toContain("35 problems in 35 sessions")
    expect(md).toContain("5 earlier problems not listed")
    expect(md).not.toContain("Problem number 4 ")
    expect(md).toContain("Problem number 34")
  })
})
