import { describe, expect, test } from "vitest"
import { REVIEW_OUTPUT_CONTRACT } from "../problems/contract.js"
import { LIMITS } from "../problems/reviewMd.js"
import { WRITING_RULES } from "../writingRules.js"
import { buildGrouperPrompt, GROUPER_CONTRACT, WRITER_CONTRACT } from "./contract.js"
import {
  CAUSE_MAX,
  FIX_PARTS_MAX,
  fixParts,
  parseGroupsMd,
  parseWrittenMd,
  WRITTEN_LIMITS,
} from "./format.js"

const FIX_TYPES = ["skill", "code", "project_guidelines", "knowledge_base", "human"]

describe("the writing rules both contracts share", () => {
  test("SC1: the review and writer contracts each print WRITING_RULES whole, and no second How to write", () => {
    for (const contract of [REVIEW_OUTPUT_CONTRACT, WRITER_CONTRACT]) {
      expect(contract).toContain(WRITING_RULES)
      expect(contract.match(/## How to write/g)).toHaveLength(1)
    }
    expect(WRITING_RULES).toContain("never saw the session or the code")
    expect(WRITING_RULES).toContain("No jargon or shorthand")
  })

  test("SC5: the four list lines are short, the story's parts are limited, and the other limits are unchanged", () => {
    expect(WRITTEN_LIMITS).toEqual({
      title: 80,
      problem: 250,
      priorityReason: 300,
      fix: 1200,
      impactReason: 200,
      howItHelps: 300,
      fixSummary: 250,
      storyStep: 200,
      storyQuote: 150,
      whyProblem: 250,
      shouldHave: 250,
      fixPartHeading: 60,
      fixPartChange: 400,
    })
    expect(CAUSE_MAX).toBe(400)
    expect(LIMITS).toEqual({
      title: 120,
      summary: 600,
      description: 600,
      learning: 300,
      severityReason: 200,
      quote: 300,
      why: 300,
      extraValue: 200,
      problems: 100,
      evidencePerProblem: 20,
      evidenceRange: 50,
      quoteMin: 2,
    })
  })
})

/** The contract's example learnings.md, and the evidence its story quotes. */
const EXAMPLE = /```markdown\n([\s\S]*?)```/.exec(WRITER_CONTRACT)?.[1] ?? ""
const EXAMPLE_RULES = {
  joined: [],
  maxHigh: 99,
  maxMedium: 99,
  projectWords: [],
  evidence: {
    G1: [
      "started jest in the background",
      "waiting on jest, will report results later",
      "all helpers reported, opening the pull request",
    ],
  },
}

describe("the writer contract", () => {
  test("SC2: the example learnings.md parses whole, with impact and how it helps", () => {
    const parsed = parseWrittenMd(EXAMPLE, ["G1", "G2"], FIX_TYPES, EXAMPLE_RULES)
    expect(parsed.errors).toEqual([])
    const g1 = parsed.answers.G1
    if (g1?.verdict !== "learning") throw new Error("G1 is not a learning")
    expect(g1.impact).toBe("wrong_result")
    expect(g1.impactReason).not.toBe("")
    expect(g1.howItHelps).not.toBe("")
    expect(parsed.answers.G2?.verdict).toBe("drop")
  })

  test("SC8: the Priority section says impact ranks wrong_result above time_only at the same frequency", () => {
    const priority = /## Priority\n([\s\S]*?)\n## /.exec(WRITER_CONTRACT)?.[1] ?? ""
    expect(priority).toMatch(/impact/)
    expect(priority).toMatch(/same frequency, wrong_result ranks above person_stepped_in/)
    expect(priority).toMatch(/person_stepped_in above time_only/)
  })
})

test("the writing rules ask for any project word to be said plainly or explained, and show bad lines next to plain ones", () => {
  expect(WRITING_RULES).toContain("would not be known to someone outside this project")
  expect(WRITING_RULES).not.toContain("resume: restart a run that stopped")
  expect(WRITING_RULES).toContain("the first real run of the requirement failed")
  expect(WRITING_RULES).toContain("Use failed only when the thing itself broke")
})

test("SC111: the example tells a 3-step story, and Problem describes the pattern, not one story", () => {
  const parsed = parseWrittenMd(EXAMPLE, ["G1", "G2"], FIX_TYPES, EXAMPLE_RULES)
  expect(parsed.errors).toEqual([])
  const g1 = parsed.answers.G1
  if (g1?.verdict !== "learning") throw new Error("G1 is not a learning")
  expect(g1.story.steps).toHaveLength(3)
  expect(WRITER_CONTRACT).toContain("must be true of every session in the group")
  expect(WRITER_CONTRACT).not.toContain("Tell one story, not many")
  expect(WRITER_CONTRACT).toContain("- **In plain words:**")
})

test("spec-3: the contract says what check.mjs refuses in the four list lines, and an updated fix keeps its title only when the check would pass it", () => {
  const flat = WRITER_CONTRACT.replace(/\s+/g, " ")
  expect(flat).toContain(
    "check.mjs` refuses any of the four that holds a backtick, a file name or path, the words yok or harness, or the name of a skill, agent, hook or command in `harness/`",
  )
  expect(flat).toContain("Avoid skill and step names even when they are everyday words")
  expect(flat).toContain(
    `Keep the title unless it is wrong, over ${WRITTEN_LIMITS.title} characters, or uses a word the list lines may not hold`,
  )
})

test("SC513: the contract's parts example passes the check, and the contract says 2 to 4 parts or one Fix", () => {
  const partsBlock =
    /## Fix in parts\n[\s\S]*?```markdown\n([\s\S]*?)```/.exec(WRITER_CONTRACT)?.[1] ?? ""
  expect(partsBlock).toContain("- **Part 1:**")
  const withParts = EXAMPLE.replace(/- \*\*Fix:\*\* [^\n]*(\n {2}[^\n]*)*\n/, partsBlock)
  const parsed = parseWrittenMd(withParts, ["G1", "G2"], FIX_TYPES, EXAMPLE_RULES)
  expect(parsed.errors).toEqual([])
  const g1 = parsed.answers.G1
  if (g1?.verdict !== "learning") throw new Error("G1 is not a learning")
  expect(fixParts(g1.fix)).toHaveLength(2)
  const flat = WRITER_CONTRACT.replace(/\s+/g, " ")
  expect(flat).toContain(`2 to ${FIX_PARTS_MAX} parts`)
  expect(flat).toContain("A habit seen at one moment keeps one Fix field and no parts")
  expect(flat).toContain("Write one learning per habit")
})

describe("the grouping contract", () => {
  const flat = GROUPER_CONTRACT.replace(/\s+/g, " ")

  test("SC530: the grouping instructions define a habit by the kind of thing done and what it skipped", () => {
    expect(flat).toContain("What kind of thing the agent did")
    expect(flat).toContain("What it skipped or got wrong in doing it")
    expect(flat).toContain(
      "the same kind of thing and skip the same thing, even when they show up at different moments",
    )
    expect(flat).toContain(
      "Never split one habit into several groups because it shows up at many moments",
    )
    expect(flat).not.toContain("probably two habits")
    expect(flat).toContain(
      "even when that learning was written for one moment and this group shows the habit at another",
    )
    expect(flat).not.toContain("one fix would stop both")
    expect(buildGrouperPrompt()).toContain("by the agent's habit")
  })

  test("SC532: the examples teach the rule without naming habits a real run is judged on", () => {
    expect(flat).toContain('"keeps using tabs after the person asked for spaces"')
    for (const hint of ["something is done", "how things work", "speaks or acts", "too dense"])
      expect(flat).not.toContain(hint)
  })

  test("SC531: the grouping instructions' groups.md example still passes the grouping check", () => {
    const example = /```markdown\n([\s\S]*?)```/.exec(GROUPER_CONTRACT)?.[1] ?? ""
    const parsed = parseGroupsMd(example, ["P1", "P4", "P9"], [])
    expect(parsed.errors).toEqual([])
    expect(parsed.groups).toHaveLength(1)
    expect(parsed.groups[0]).toMatchObject({ joins: null, problems: ["P1", "P4", "P9"] })
  })
})

describe("who stepped in decides the priority", () => {
  const flat = WRITER_CONTRACT.replace(/\s+/g, " ")

  test("SC533: a person re-running or chasing a failure is stepping in, not recovering", () => {
    expect(flat).toContain("Recovered means the agent or an automatic check fixed it without help")
    expect(flat).toContain("re-run it, retry it, chase it or ask about it, the person stepped in")
    expect(flat).toContain("re-run or chase what the agent left failing or stuck")
  })

  test("SC534: a failed release or work stuck for hours is high", () => {
    expect(flat).toContain(
      "A release or other ship step that failed, or work left stuck for hours, is high",
    )
  })

  test("SC535: every writer is told to name who did it, never someone", () => {
    expect(WRITING_RULES.replace(/\s+/g, " ")).toContain(
      'Say who did it: the agent, the person, or a named tool or check. Never "someone"',
    )
  })
})
