import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "vitest"
import { quoteChecker } from "../problems/reviewMd.js"
import {
  fixParts,
  groupsForWriter,
  knownLearningsMd,
  oneOffReason,
  parseGroupsMd,
  parseWrittenMd,
  problemsMd,
  storyEvidence,
  writtenCheckScript,
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

const JEST = ["waiting on jest"]

/** Rules and limits loose enough not to matter, for tests about something else. */
const ANY = {
  joined: [],
  maxHigh: 99,
  maxMedium: 99,
  evidence: { G1: JEST, G2: JEST, G3: JEST },
  projectWords: [],
}

/** A 3-step example whose every quote is the fixture problem's evidence. */
const STORY = `- **Step 1:** A helper started the tests.
- **Step 1 quote:** waiting on jest
- **Step 2:** It reported before they finished.
- **Step 2 quote:** waiting on jest
- **Step 3:** The main agent took that as done.
- **Step 3 quote:** waiting on jest
- **Why it's a problem:** Nobody saw the tests pass.
- **What should have happened:** It should have waited for the tests.
`
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
    impact: null,
    impactReason: null,
    howItHelps: null,
    fixSummary: null,
    story: null,
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
    expect(md).toContain("3 problems in 2 sessions, happened 3 times")
    expect(md).toContain("severity: 1 high, 2 medium, 0 low")
    expect(md).toContain("class: 1 missed, 0 blocked, 2 slow, 0 caught")
  })

  const written = `## G1
- **Verdict:** learning
- **Title:** Helpers stop before background runs finish
- **Problem:** Coder agents report while jest still runs, so the orchestrator chases them.
- **Priority:** high — 3 sessions, and one shipped a wrong result
- **Impact:** wrong_result — one session shipped code whose tests were still running
- **Fix type:** skill
- **Fix:** In skills/implement/SKILL.md, add: wait for the run to exit before reporting.
- **In plain words:** Make helpers wait for their tests to finish before they report.
- **How it helps:** Stops untested work from shipping.
${STORY}
## G2
- **Verdict:** drop
- **Why:** One session, medium and slow, a one-off typo.
`

  test("a learning written earlier in this same run says so, and that nobody has added its fix yet", () => {
    const md = groupsForWriter(
      [{ id: "G1", cause: "x", existing, existingFromThisRun: true, problems: [problem("a")] }],
      ROOM,
    )
    expect(md).toContain("written earlier in this run")
    expect(md).toContain("nobody has had a chance to add its fix")
  })

  test("a learning from an earlier run carries no such note", () => {
    const md = groupsForWriter(
      [{ id: "G1", cause: "x", existing, existingFromThisRun: false, problems: [problem("a")] }],
      ROOM,
    )
    expect(md).not.toContain("written earlier in this run")
  })

  test("a learning needs its fix in plain words, read back as fixSummary", () => {
    const parsed = parseWrittenMd(written, ["G1", "G2"], FIX_TYPES, ANY)
    expect(parsed.errors).toEqual([])
    expect(parsed.answers.G1).toMatchObject({
      fixSummary: "Make helpers wait for their tests to finish before they report.",
    })
    const without = parseWrittenMd(
      written.replace(/- \*\*In plain words:\*\*.*\n/, ""),
      ["G1", "G2"],
      FIX_TYPES,
      ANY,
    )
    expect(without.errors).toContain("G1: missing In plain words")
  })

  test("LW2: the times it happened count every evidence line, so a mistake repeated in one session shows", () => {
    const repeated = problem("a", {
      evidence: [1, 2, 3, 4].map((n) => ({
        from: `msg-${n}`,
        to: `msg-${n}`,
        quote: "waiting on jest",
        why: "returned early again",
      })),
    })
    const md = groupsForWriter(
      [{ id: "G1", cause: "x", existing: null, problems: [repeated] }],
      ROOM,
    )
    expect(md).toContain("1 problems in 1 sessions, happened 4 times")
  })

  test("LW3: a learning and a drop are both read back", () => {
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
      impact: "wrong_result",
      impactReason: "one session shipped code whose tests were still running",
      howItHelps: "Stops untested work from shipping.",
      fixSummary: "Make helpers wait for their tests to finish before they report.",
      story: {
        steps: [
          { text: "A helper started the tests.", quote: "waiting on jest" },
          { text: "It reported before they finished.", quote: "waiting on jest" },
          { text: "The main agent took that as done.", quote: "waiting on jest" },
        ],
        whyProblem: "Nobody saw the tests pass.",
        shouldHave: "It should have waited for the tests.",
      },
    })
    expect(parsed.answers.G2).toEqual({
      verdict: "drop",
      reason: "One session, medium and slow, a one-off typo.",
    })
  })

  test("LW4: a group left unanswered, a bad priority, or a fix type outside the list is an error", () => {
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

  test("SC3: a learning without Impact or How it helps fails the check, naming the field", () => {
    const g2Learning = written
      .replace(
        "- **Verdict:** drop\n- **Why:** One session, medium and slow, a one-off typo.\n",
        "",
      )
      .concat(
        `- **Verdict:** learning\n- **Title:** t\n- **Problem:** p\n- **Priority:** low — rare\n- **Impact:** time_only — slow\n- **Fix type:** skill\n- **Fix:** f\n${STORY}`,
      )
    const parsed = parseWrittenMd(
      g2Learning.replace(/- \*\*Impact:\*\* wrong_result.*\n/, ""),
      ["G1", "G2"],
      FIX_TYPES,
      ANY,
    )
    const errors = parsed.errors.join("\n")
    expect(errors).toMatch(/G1: missing Impact/)
    expect(errors).toMatch(/G2: missing How it helps/)
    expect(parsed.answers.G1).toBeUndefined()
    expect(parsed.answers.G2).toBeUndefined()
  })

  test.each([
    ["catastrophic — x", /G1: Impact must be wrong_result, person_stepped_in or time_only/],
    ["time_only", /G1: Impact needs one sentence after the word/],
    [`time_only — ${"a".repeat(201)}`, /G1: the impact sentence is over 200 characters/],
  ])(
    "SC4: Impact %#: a bad word, a missing sentence or a 201-character one is an error",
    (impact, error) => {
      const parsed = parseWrittenMd(
        written.replace(/(- \*\*Impact:\*\* ).*\n/, `$1${impact}\n`),
        ["G1", "G2"],
        FIX_TYPES,
        ANY,
      )
      expect(parsed.errors.join("\n")).toMatch(error)
      expect(parsed.answers.G1).toBeUndefined()
    },
  )

  test("SC6: the generated check.mjs refuses a learnings.md missing How it helps, naming it", () => {
    const dir = mkdtempSync(join(tmpdir(), "written-check-"))
    try {
      writeFileSync(join(dir, "check.mjs"), writtenCheckScript(["G1", "G2"], FIX_TYPES, ANY))
      writeFileSync(join(dir, "learnings.md"), written.replace(/- \*\*How it helps:\*\*.*\n/, ""))
      let output = ""
      let status = 0
      try {
        execFileSync("node", ["check.mjs"], { cwd: dir, encoding: "utf8" })
      } catch (error) {
        const failed = error as { status: number; stdout: string }
        status = failed.status
        output = failed.stdout
      }
      expect(status).toBe(1)
      expect(output).toContain("G1: missing How it helps")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("SC7: groups.md shows an updated learning's impact and how it helps only when it has them", () => {
    const md = groupsForWriter(
      [
        {
          id: "G1",
          cause: "x",
          existing: {
            ...existing,
            impact: "wrong_result",
            impactReason: "shipped untested code",
            howItHelps: "Stops untested work from shipping.",
          },
          problems: [problem("a")],
        },
        { id: "G2", cause: "y", existing, problems: [problem("b")] },
      ],
      ROOM,
    )
    const [g1, g2] = md.split("## G2")
    expect(g1).toContain("  - Impact: wrong_result — shipped untested code")
    expect(g1).toContain("  - How it helps: Stops untested work from shipping.")
    expect(g2).not.toContain("Impact:")
    expect(g2).not.toContain("How it helps:")
  })

  test("LW5: a group that updates an existing learning cannot be dropped", () => {
    const parsed = parseWrittenMd(
      "## G1\n- **Verdict:** drop\n- **Why:** one-off\n",
      ["G1"],
      FIX_TYPES,
      { ...ANY, joined: ["G1"], maxHigh: 5, maxMedium: 8 },
    )
    expect(parsed.errors.join("\n")).toMatch(/G1: it updates an existing learning/)
  })

  test("LW6: new learnings over the high limit fail; updated ones do not count", () => {
    const high = (id: string) =>
      `## ${id}\n- **Verdict:** learning\n- **Title:** t\n- **Problem:** p\n- **Priority:** high — why\n- **Impact:** time_only — slow\n- **Fix type:** skill\n- **Fix:** f\n- **How it helps:** h\n- **In plain words:** Make the agent wait before it reports.\n${STORY}`
    const md = ["G1", "G2", "G3"].map(high).join("\n")
    const over = parseWrittenMd(md, ["G1", "G2", "G3"], FIX_TYPES, {
      ...ANY,
      maxHigh: 2,
      maxMedium: 8,
    })
    expect(over.errors.join("\n")).toMatch(/3 new learnings are high \(G1, G2, G3\).*at most 2/)
    const updated = parseWrittenMd(md, ["G1", "G2", "G3"], FIX_TYPES, {
      ...ANY,
      joined: ["G3"],
      maxHigh: 2,
      maxMedium: 8,
    })
    expect(updated.errors).toEqual([])
  })

  test("LW7: agent 2's file says how many high and medium this batch may still make", () => {
    const md = groupsForWriter(
      [{ id: "G1", cause: "x", existing: null, problems: [problem("a")] }],
      {
        high: 2,
        medium: 8,
      },
    )
    expect(md).toContain("at most 2 new high-priority and 8 new medium-priority learnings")
  })

  test("LW8: a drop needs one sentence why, and is read back", () => {
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

  test("LW9: a new problem's excerpt is shown under it; a problem without one shows none", () => {
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

  test("LW10: a learning with many problems lists only the newest, but counts them all", () => {
    const many = Array.from({ length: 35 }, (_, index) =>
      problem(`p${index}`, { title: `Problem number ${index}` }),
    )
    const md = groupsForWriter([{ id: "G1", cause: "x", existing: null, problems: many }], ROOM)
    expect(md).toContain("35 problems in 35 sessions, happened 35 times")
    expect(md).toContain("5 earlier problems not listed")
    expect(md).not.toContain("Problem number 4 ")
    expect(md).toContain("Problem number 34")
  })
})

describe("one-off groups, dropped by code before agent 2", () => {
  const times = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      from: `msg-${i}`,
      to: `msg-${i}`,
      quote: "waiting on jest",
      why: "returned early",
    }))

  test("LO1: one session, nothing high, under 3 times is a one-off, with the reason", () => {
    expect(oneOffReason([problem("a", { sessionId: "s1", evidence: times(2) })])).toBe(
      "One session, no high-severity problem, and it happened 2 times.",
    )
  })

  test("LO2: a second session, a high-severity problem, or 3 times in one session keeps it", () => {
    const two = [problem("a", { sessionId: "s1" }), problem("b", { sessionId: "s2" })]
    expect(oneOffReason(two)).toBeNull()
    expect(oneOffReason([problem("a", { severity: "high" })])).toBeNull()
    expect(oneOffReason([problem("a", { evidence: times(3) })])).toBeNull()
  })
})

describe("the four list lines and the example story", () => {
  const learning = (story: string = STORY) => `## G1
- **Verdict:** learning
- **Title:** Helpers report while their tests still run
- **Problem:** Helper agents say they are done while their tests still run.
- **Priority:** high — 3 sessions
- **Impact:** wrong_result — one session shipped untested code
- **Fix type:** skill
- **Fix:** In skills/implement/SKILL.md, add a wait rule.
- **How it helps:** Stops untested work from shipping.
- **In plain words:** Make helpers wait for their tests, so what they report was seen.
${story}`
  const RULES = { joined: [], maxHigh: 9, maxMedium: 9, evidence: { G1: JEST }, projectWords: [] }
  const errorsOf = (md: string, rules = RULES) =>
    parseWrittenMd(md, ["G1"], FIX_TYPES, rules).errors.join("\n")

  test("SC101: a 3-step story whose quotes are in the group's evidence is read back step by step", () => {
    const parsed = parseWrittenMd(learning(), ["G1"], FIX_TYPES, RULES)
    expect(parsed.errors).toEqual([])
    expect(parsed.answers.G1).toMatchObject({
      story: {
        steps: [
          { text: "A helper started the tests.", quote: "waiting on jest" },
          { text: "It reported before they finished.", quote: "waiting on jest" },
          { text: "The main agent took that as done.", quote: "waiting on jest" },
        ],
        whyProblem: "Nobody saw the tests pass.",
        shouldHave: "It should have waited for the tests.",
      },
    })
  })

  const notInEvidence = learning(
    STORY.replace(
      "- **Step 2 quote:** waiting on jest",
      "- **Step 2 quote:** the tests all passed",
    ),
  )

  test("SC102: a story quote not in the group's evidence fails, naming the step and the quote", () => {
    const parsed = parseWrittenMd(notInEvidence, ["G1"], FIX_TYPES, RULES)
    expect(parsed.errors.join("\n")).toContain(
      `G1: Step 2 quote "the tests all passed" is not in this group's evidence`,
    )
    expect(parsed.answers.G1).toBeUndefined()
  })

  test("SC103: a quote may come from the session records an excerpt shows, never from the reviewer's note", () => {
    const evidence = storyEvidence([
      problem("a", {
        excerpt:
          'msg-1 — "waiting on jest" — returned early\n\n```text\n[msg-1] assistant: npm test is still going\n```',
      }),
    ])
    const story = (quote: string) =>
      learning(STORY.replace("- **Step 1 quote:** waiting on jest", `- **Step 1 quote:** ${quote}`))
    const rules = { ...RULES, evidence: { G1: evidence } }
    expect(errorsOf(story("npm test is still going"), rules)).toBe("")
    expect(errorsOf(story("waiting on jest"), rules)).toBe("")
    expect(errorsOf(story("returned early"), rules)).toContain(
      `Step 1 quote "returned early" is not in this group's evidence`,
    )
  })

  test("SC104: a quote may skip words with … and still match", () => {
    const rules = {
      ...RULES,
      evidence: { G1: [...JEST, "I will wait for jest to finish before I report"] },
    }
    const md = learning(
      STORY.replace(
        "- **Step 1 quote:** waiting on jest",
        "- **Step 1 quote:** I will wait … before I report",
      ),
    )
    expect(errorsOf(md, rules)).toBe("")
  })

  test.each([
    ["a JSON-escaped quote mark", 'he said \\"done\\" and left', 'he said "done" and left'],
    ["a JSON-escaped newline", "line one\\nline two of the log", "line one line two of the log"],
    ["curly quote marks", "he said “done” and left", "he said done and left"],
    ["mixed case", "Waiting On The Jest Runner", "waiting on the jest runner"],
    ["extra whitespace", "waiting   on\n\tthe jest runner", "waiting on the jest runner"],
  ])(
    "testing-1: a quote matches evidence with %s, the same as a problem's quote check",
    (_, evidence, quote) => {
      const rules = { ...RULES, evidence: { G1: [evidence] } }
      const md = learning(STORY.replace(/(Step \d quote:\*\* ).*/g, `$1${quote}`))
      expect(errorsOf(md, rules)).toBe("")
      const record = {
        seq: 0,
        id: "msg-1",
        msgType: "message",
        track: "main",
        text: evidence,
      } as const
      expect(quoteChecker([record])({ from: "msg-1", to: "msg-1", quote })).toBeUndefined()
    },
  )

  test.each([
    ["from two different evidence texts", "waiting on jest … nothing has passed"],
    ["in the wrong order", "before I report … I will wait"],
  ])("spec-1: a quote whose pieces around … come %s fails", (_, quote) => {
    const rules = {
      ...RULES,
      evidence: {
        G1: [...JEST, "nothing has passed yet", "I will wait for jest to finish before I report"],
      },
    }
    const md = learning(
      STORY.replace("- **Step 1 quote:** waiting on jest", `- **Step 1 quote:** ${quote}`),
    )
    expect(errorsOf(md, rules)).toContain(`Step 1 quote "${quote}" is not in this group's evidence`)
  })

  test.each([
    [2, STORY.replace(/- \*\*Step 3[^\n]*\n- \*\*Step 3 quote[^\n]*\n/, "")],
    [
      5,
      STORY.replace(
        "- **Why it's",
        "- **Step 4:** Four.\n- **Step 4 quote:** waiting on jest\n- **Step 5:** Five.\n- **Step 5 quote:** waiting on jest\n- **Why it's",
      ),
    ],
  ])("SC105: a story with %i steps fails, saying how many it has", (count, story) => {
    expect(errorsOf(learning(story))).toContain(
      `G1: the example needs 3 or 4 steps, numbered from Step 1 with no gap; it has ${count}`,
    )
  })

  test.each([
    [/- \*\*Why it's a problem:\*\*[^\n]*\n/, "G1: missing Why it's a problem"],
    [/- \*\*What should have happened:\*\*[^\n]*\n/, "G1: missing What should have happened"],
    [/- \*\*Step 2 quote:\*\*[^\n]*\n/, "G1: Step 2 needs - **Step 2 quote:**"],
  ])("SC106: a story missing %s fails naming it", (line, error) => {
    const parsed = parseWrittenMd(learning(STORY.replace(line, "")), ["G1"], FIX_TYPES, RULES)
    expect(parsed.errors.join("\n")).toContain(error)
    expect(parsed.answers.G1).toBeUndefined()
  })

  test("SC107: Why it’s a problem with a curly apostrophe reads the same as a straight one", () => {
    const parsed = parseWrittenMd(
      learning(STORY.replace("Why it's a problem", "Why it’s a problem")),
      ["G1"],
      FIX_TYPES,
      RULES,
    )
    expect(parsed.errors).toEqual([])
    expect(parsed.answers.G1).toMatchObject({ story: { whyProblem: "Nobody saw the tests pass." } })
  })

  test("SC108: each of the four list lines over its new limit fails, naming it", () => {
    const md = learning()
      .replace(/(- \*\*Title:\*\* ).*\n/, `$1${"t".repeat(81)}\n`)
      .replace(/(- \*\*Problem:\*\* ).*\n/, `$1${"p".repeat(251)}\n`)
      .replace(/(- \*\*Impact:\*\* ).*\n/, `$1time_only — ${"i".repeat(201)}\n`)
      .replace(/(- \*\*In plain words:\*\* ).*\n/, `$1${"w".repeat(251)}\n`)
    const errors = errorsOf(md)
    expect(errors).toContain("G1: Title is over 80 characters")
    expect(errors).toContain("G1: Problem is over 250 characters")
    expect(errors).toContain("G1: the impact sentence is over 200 characters")
    expect(errors).toContain("G1: In plain words is over 250 characters")
  })

  test("testing-2: each story field over its limit fails, naming it", () => {
    const story = STORY.replace(/(- \*\*Step 1:\*\* ).*\n/, `$1${"s".repeat(201)}\n`)
      .replace(/(- \*\*Step 2 quote:\*\* ).*\n/, `$1${"q".repeat(151)}\n`)
      .replace(/(- \*\*Why it's a problem:\*\* ).*\n/, `$1${"y".repeat(251)}\n`)
      .replace(/(- \*\*What should have happened:\*\* ).*\n/, `$1${"h".repeat(251)}\n`)
    const errors = errorsOf(learning(story))
    expect(errors).toContain("G1: Step 1 is over 200 characters")
    expect(errors).toContain("G1: Step 2 quote is over 150 characters")
    expect(errors).toContain("G1: Why it's a problem is over 250 characters")
    expect(errors).toContain("G1: What should have happened is over 250 characters")
  })

  test("SC109: the generated check.mjs refuses a story quote missing from the evidence, as code does", () => {
    const dir = mkdtempSync(join(tmpdir(), "written-check-"))
    try {
      writeFileSync(join(dir, "check.mjs"), writtenCheckScript(["G1"], FIX_TYPES, RULES))
      writeFileSync(join(dir, "learnings.md"), notInEvidence)
      let output = ""
      let status = 0
      try {
        execFileSync("node", ["check.mjs"], { cwd: dir, encoding: "utf8" })
      } catch (error) {
        const failed = error as { status: number; stdout: string }
        status = failed.status
        output = failed.stdout
      }
      expect(status).toBe(1)
      expect(output).toContain(
        `G1: Step 2 quote "the tests all passed" is not in this group's evidence`,
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("project words in the four list lines", () => {
  const learning = `## G1
- **Verdict:** learning
- **Title:** Helpers report while their tests still run
- **Problem:** Helper agents say they are done while their tests still run.
- **Priority:** high — 3 sessions
- **Impact:** wrong_result — one session shipped untested code
- **Fix type:** skill
- **Fix:** In skills/implement/SKILL.md, add a wait rule.
- **How it helps:** Stops untested work from shipping.
- **In plain words:** Make helpers wait for their tests, so what they report was seen.
${STORY}`
  const rules = (projectWords: ReadonlyArray<string>) => ({
    joined: [],
    maxHigh: 9,
    maxMedium: 9,
    evidence: { G1: [...JEST, "run `npm test` now"] },
    projectWords,
  })
  const field = (md: string, name: string, value: string) =>
    md.replace(new RegExp(`(- \\*\\*${name}:\\*\\* ).*\\n`), `$1${value}\n`)
  const titleHasWord = field(learning, "Title", "The code-review step skips tests")

  test("SC202: a list line with a project word fails, naming the field and the word", () => {
    const parsed = parseWrittenMd(titleHasWord, ["G1"], FIX_TYPES, rules(["code-review"]))
    expect(parsed.errors.join("\n")).toContain('G1: Title uses the project word "code-review"')
    expect(parsed.answers.G1).toBeUndefined()
  })

  test.each([
    ["Problem", "The yok run stops early.", 'Problem uses the project word "yok"'],
    ["Impact", "time_only — the `npm test` run was lost", "the impact sentence uses a backtick"],
    [
      "In plain words",
      "Add a rule to skills/implement.",
      'In plain words uses the file path "skills/implement"',
    ],
    ["Title", "SKILL.md lacks a wait rule", 'Title uses the file name "SKILL.md"'],
  ])("SC203: %s with %j fails, naming what it found", (name, value, error) => {
    const parsed = parseWrittenMd(field(learning, name, value), ["G1"], FIX_TYPES, rules(["yok"]))
    expect(parsed.errors.join("\n")).toContain(`G1: ${error}`)
  })

  test.each([
    ["In plain words", "Make helpers wait in 9/10 sessions and/or ask first."],
    ["Problem", "Helpers report a pass/fail result before the run ends."],
  ])("defects-2: %s with a fraction or a slash pair such as %j passes", (name, value) => {
    expect(
      parseWrittenMd(field(learning, name, value), ["G1"], FIX_TYPES, rules([])).errors,
    ).toEqual([])
  })

  test("defects-2: a path after a fraction is still refused", () => {
    const md = field(learning, "Problem", "In 9/10 sessions the rule in src/foo is skipped.")
    expect(parseWrittenMd(md, ["G1"], FIX_TYPES, rules([])).errors.join("\n")).toContain(
      'G1: Problem uses the file path "src/foo"',
    )
  })

  test("SC204: a word is matched whole, so code review and orchestrated pass", () => {
    const md = field(learning, "Problem", "The code review is orchestrated badly.")
    const parsed = parseWrittenMd(md, ["G1"], FIX_TYPES, rules(["code-review", "orchestrate"]))
    expect(parsed.errors).toEqual([])
  })

  test("SC205: Fix, How it helps and the story may name files and project words", () => {
    const md = field(
      field(learning, "How it helps", "The yok run stops chasing helpers."),
      "Fix",
      "In skills/implement/SKILL.md add a rule.",
    ).replace("- **Step 1 quote:** waiting on jest", "- **Step 1 quote:** run `npm test` now")
    const parsed = parseWrittenMd(md, ["G1"], FIX_TYPES, rules(["yok"]))
    expect(parsed.errors).toEqual([])
  })

  test("SC206: the generated check.mjs refuses a project word, as code does", () => {
    const dir = mkdtempSync(join(tmpdir(), "written-check-"))
    try {
      writeFileSync(
        join(dir, "check.mjs"),
        writtenCheckScript(["G1"], FIX_TYPES, rules(["code-review"])),
      )
      writeFileSync(join(dir, "learnings.md"), titleHasWord)
      let output = ""
      let status = 0
      try {
        execFileSync("node", ["check.mjs"], { cwd: dir, encoding: "utf8" })
      } catch (error) {
        const failed = error as { status: number; stdout: string }
        status = failed.status
        output = failed.stdout
      }
      expect(status).toBe(1)
      expect(output).toContain('G1: Title uses the project word "code-review"')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("a fix in parts", () => {
  const learning = (fix: string) => `## G1
- **Verdict:** learning
- **Title:** Does not check before it speaks or acts
- **Problem:** The agent says how things work, or that work is done, without checking first.
- **Priority:** high — 3 sessions
- **Impact:** wrong_result — one session shipped untested code
- **Fix type:** skill
${fix}
- **How it helps:** Stops claims nobody checked.
- **In plain words:** Make the agent check before it explains, reports or runs something risky.
${STORY}`
  const RULES = {
    joined: [],
    maxHigh: 9,
    maxMedium: 9,
    evidence: { G1: JEST },
    projectWords: [] as ReadonlyArray<string>,
  }
  const part = (n: number, heading: string, change = `In skills/s${n}/SKILL.md, add rule ${n}.`) =>
    `- **Part ${n}:** ${heading}\n- **Part ${n} change:** ${change}`
  const parts = (count: number) =>
    Array.from({ length: count }, (_, i) => part(i + 1, `Before moment ${i + 1}`)).join("\n")
  const parse = (fix: string, rules = RULES) =>
    parseWrittenMd(learning(fix), ["G1"], FIX_TYPES, rules)
  const errorsOf = (fix: string, rules = RULES) => parse(fix, rules).errors.join("\n")

  test("SC501: a 3-part fix is read back as one learning whose fix splits into the same 3 parts", () => {
    const parsed = parse(
      [
        part(
          1,
          "Before explaining how something works",
          "In skills/answer/SKILL.md, read the code first.",
        ),
        part(2, "Before saying something is done", "In skills/implement/SKILL.md, run it first."),
        part(3, "Before deleting or publishing", "In skills/ship/SKILL.md, ask first."),
      ].join("\n"),
    )
    expect(parsed.errors).toEqual([])
    const g1 = parsed.answers.G1
    if (g1?.verdict !== "learning") throw new Error("G1 is not a learning")
    expect(g1.fix.startsWith("### Before explaining how something works")).toBe(true)
    expect(fixParts(g1.fix)).toEqual([
      {
        heading: "Before explaining how something works",
        change: "In skills/answer/SKILL.md, read the code first.",
      },
      {
        heading: "Before saying something is done",
        change: "In skills/implement/SKILL.md, run it first.",
      },
      { heading: "Before deleting or publishing", change: "In skills/ship/SKILL.md, ask first." },
    ])
  })

  test("SC502: a plain Fix field is read exactly as before and has no parts", () => {
    const parsed = parse("- **Fix:** In skills/implement/SKILL.md, add a wait rule.")
    expect(parsed.errors).toEqual([])
    const g1 = parsed.answers.G1
    if (g1?.verdict !== "learning") throw new Error("G1 is not a learning")
    expect(g1.fix).toBe("In skills/implement/SKILL.md, add a wait rule.")
    expect(fixParts(g1.fix)).toBeNull()
  })

  test("SC503: five parts are refused, and G1 gets no answer", () => {
    const parsed = parse(parts(5))
    expect(parsed.errors.join("\n")).toContain("G1: the fix has 5 parts; at most 4")
    expect(parsed.answers.G1).toBeUndefined()
  })

  test("a part number far past 4 is refused at once, with one error, not one per gap", () => {
    const started = Date.now()
    const errors = parse([part(1, "Before a"), part(10_000_000, "Before z")].join("\n")).errors
    expect(Date.now() - started).toBeLessThan(500)
    expect(errors).toEqual([
      "G1: the parts are numbered from Part 1 with no gap; Part 2 is missing: renumber Part 10000000",
    ])
  })

  test("a Part 0 is refused, beside other parts or beside a plain Fix", () => {
    const zero = "G1: the parts are numbered from Part 1; there is no Part 0"
    expect(errorsOf([part(0, "Before z"), parts(2)].join("\n"))).toContain(zero)
    expect(errorsOf(`- **Fix:** Add a rule.\n${part(0, "Before z")}`)).toContain(zero)
  })

  test("a change starting with a markdown heading is refused, since it would read as a new part", () => {
    expect(
      errorsOf([part(1, "Before a", "### hashes first"), part(2, "Before b")].join("\n")),
    ).toContain("G1: Part 1 change starts with #: start it with words, not a heading")
  })

  test.each<[string, ReadonlyArray<{ heading: string; change: string }>]>([
    [
      "a change starting with ### ",
      [
        { heading: "Before a", change: "### hashes first" },
        { heading: "Before b", change: "Add a rule." },
      ],
    ],
    [
      "a heading starting with ### ",
      [
        { heading: "### Before a", change: "Add a rule." },
        { heading: "Before b", change: "Add another rule." },
      ],
    ],
    [
      "a heading and a change holding # in the middle",
      [
        { heading: "Before step #3 runs", change: "Add a rule, then ### mark it." },
        { heading: "Before b", change: "Add a rule ## here." },
      ],
    ],
    [
      "four parts at the length limits",
      [1, 2, 3, 4].map((n) => ({ heading: `${n}`.repeat(60), change: `${n}`.repeat(240) })),
    ],
  ])("every fix in parts the check accepts splits back into the same parts: %s", (_, written) => {
    const parsed = parse(written.map((p, i) => part(i + 1, p.heading, p.change)).join("\n"))
    const g1 = parsed.answers.G1
    if (g1?.verdict !== "learning") {
      expect(parsed.errors).not.toEqual([])
      return
    }
    expect(fixParts(g1.fix)).toEqual(written)
  })

  test("the 1200 limit counts the headings and changes written, not the markup between them", () => {
    const full = (extra: string) =>
      [1, 2, 3, 4]
        .map((n) => part(n, `${n}`.repeat(60), `${n}`.repeat(240) + (n === 4 ? extra : "")))
        .join("\n")
    expect(parse(full("")).errors).toEqual([])
    expect(errorsOf(full("x"))).toContain("G1: the parts together are over 1200 characters")
  })

  test("two parts with the same heading are refused, naming the repeat", () => {
    expect(errorsOf([part(1, "Before a"), part(2, "before A ")].join("\n"))).toContain(
      "G1: Part 2 has the same heading as Part 1: give each moment its own heading",
    )
    expect(
      errorsOf([part(1, "Before a"), part(3, "Before c"), part(4, "Before c")].join("\n")),
    ).toContain("G1: Part 4 has the same heading as Part 3: give each moment its own heading")
  })

  test("SC504: one part on its own is refused, pointing at the Fix field", () => {
    expect(errorsOf(parts(1))).toContain(
      "G1: a fix with one part is a plain fix: write it as - **Fix:** instead",
    )
  })

  test("SC505: a gap in the numbering is refused, naming the missing part", () => {
    expect(errorsOf([part(1, "Before a"), part(3, "Before c")].join("\n"))).toContain(
      "G1: the parts are numbered from Part 1 with no gap; Part 2 is missing",
    )
  })

  test("four parts with a gap past Part 4 are told which part is missing, not that there are too many", () => {
    const fix = [part(1, "Before a"), part(2, "Before b"), part(3, "Before c"), part(6, "Before f")]
    expect(parse(fix.join("\n")).errors).toEqual([
      "G1: the parts are numbered from Part 1 with no gap; Part 4 is missing: renumber Part 6",
    ])
  })

  test("SC506: a part missing its change, or its heading, is refused by number", () => {
    expect(errorsOf(`${part(1, "Before a")}\n- **Part 2:** Before b`)).toContain(
      "G1: Part 2 needs - **Part 2 change:** with its exact change",
    )
    expect(errorsOf(`${part(1, "Before a")}\n- **Part 2 change:** Add a rule.`)).toContain(
      "G1: Part 2 has a change but no heading",
    )
  })

  test("SC507: a Fix field written beside parts is refused", () => {
    expect(errorsOf(`- **Fix:** Add a rule.\n${parts(2)}`)).toContain(
      "G1: write the fix as - **Fix:** or as parts (- **Part 1:** and on), not both",
    )
  })

  test("SC508: a heading holding a file path or a project word is refused", () => {
    expect(
      errorsOf(
        [part(1, "Before editing skills/implement/SKILL.md"), part(2, "Before b")].join("\n"),
      ),
    ).toContain('G1: Part 1 uses the file path "skills/implement/SKILL.md"')
    expect(
      errorsOf([part(1, "Before implement ends"), part(2, "Before b")].join("\n"), {
        ...RULES,
        projectWords: ["implement"],
      }),
    ).toContain('G1: Part 1 uses the project word "implement"')
  })

  test("SC509: parts over their limits are refused", () => {
    expect(
      errorsOf([part(1, "Before a", "c".repeat(401)), part(2, "Before b")].join("\n")),
    ).toContain("G1: Part 1 change is over 400 characters")
    const long = [1, 2, 3, 4].map((n) => part(n, `Before ${n}`, "c".repeat(390))).join("\n")
    expect(errorsOf(long)).toContain("G1: the parts together are over 1200 characters")
  })

  test.each([
    ["one block", "### a\n\nAdd a rule."],
    ["a heading with no change", "### a\n\nAdd a rule.\n\n### b"],
    ["a plain line starting ### ", "### Add a rule to the skill."],
    ["five blocks", [1, 2, 3, 4, 5].map((n) => `### h${n}\n\nchange ${n}`).join("\n\n")],
  ])("SC510: text that only looks like parts splits into none: %s", (_, text) => {
    expect(fixParts(text)).toBeNull()
  })

  test("SC511: the generated check.mjs refuses five parts, as code does", () => {
    const dir = mkdtempSync(join(tmpdir(), "written-check-"))
    try {
      writeFileSync(join(dir, "check.mjs"), writtenCheckScript(["G1"], FIX_TYPES, RULES))
      writeFileSync(join(dir, "learnings.md"), learning(parts(5)))
      let output = ""
      let status = 0
      try {
        execFileSync("node", ["check.mjs"], { cwd: dir, encoding: "utf8" })
      } catch (error) {
        const failed = error as { status: number; stdout: string }
        status = failed.status
        output = failed.stdout
      }
      expect(status).toBe(1)
      expect(output).toContain("G1: the fix has 5 parts; at most 4")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("SC512: an existing learning's parts reach the writer as numbered parts", () => {
    const fix = parse(parts(2)).answers.G1
    if (fix?.verdict !== "learning") throw new Error("G1 is not a learning")
    const md = groupsForWriter(
      [
        {
          id: "G1",
          cause: "Does not check first.",
          existing: {
            id: "k",
            title: "Does not check",
            cause: "Does not check first.",
            problem: "It speaks before checking.",
            priority: "high",
            priorityReason: "Many sessions.",
            fixType: "skill",
            fix: fix.fix,
            impact: null,
            impactReason: null,
            howItHelps: null,
            fixSummary: null,
            story: null,
          },
          problems: [problem("a")],
        },
      ],
      ROOM,
    )
    expect(md).toContain("  - Fix, in 2 parts:")
    expect(md).toContain("    - Part 1: Before moment 1 — In skills/s1/SKILL.md, add rule 1.")
    expect(md).toContain("    - Part 2: Before moment 2 — In skills/s2/SKILL.md, add rule 2.")
    expect(md).not.toContain("### ")
  })
})
