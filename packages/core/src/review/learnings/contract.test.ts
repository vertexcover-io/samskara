import { describe, expect, test } from "vitest"
import { REVIEW_OUTPUT_CONTRACT } from "../problems/contract.js"
import { LIMITS } from "../problems/reviewMd.js"
import { WRITING_RULES } from "../writingRules.js"
import { WRITER_CONTRACT } from "./contract.js"
import { CAUSE_MAX, parseWrittenMd, WRITTEN_LIMITS } from "./format.js"

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

  test("SC5: every existing character limit is unchanged", () => {
    expect(WRITTEN_LIMITS).toMatchObject({
      title: 120,
      problem: 600,
      priorityReason: 300,
      fix: 1200,
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

describe("the writer contract", () => {
  test("SC2: the example learnings.md parses whole, with impact and how it helps", () => {
    const example = /```markdown\n([\s\S]*?)```/.exec(WRITER_CONTRACT)?.[1] ?? ""
    const parsed = parseWrittenMd(example, ["G1", "G2"], FIX_TYPES, {
      joined: [],
      maxHigh: 99,
      maxMedium: 99,
    })
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

test("the writer tells one story in a fixed order, says how often, and writes the fix in plain words", () => {
  expect(WRITER_CONTRACT).toContain("Tell one story, not many")
  for (const step of [
    "1. What the agent was doing.",
    "2. What it did wrong.",
    "3. What happened because of it.",
    "4. What it should have done instead.",
  ])
    expect(WRITER_CONTRACT).toContain(step)
  expect(WRITER_CONTRACT).toContain("This happened in 11 sessions.")
  expect(WRITER_CONTRACT).toContain("- **In plain words:**")
})
