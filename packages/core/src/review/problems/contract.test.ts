import { describe, expect, test } from "vitest"
import type { SessionExport } from "../export.js"
import {
  assembleReviewContract,
  BASE_REVIEW_INSTRUCTIONS,
  REVIEW_OUTPUT_CONTRACT,
  sessionJsonText,
} from "./contract.js"
import { parseReviewMd } from "./reviewMd.js"

describe("review contract", () => {
  test("C1: the example review.md in the contract parses whole, so the contract and the parser agree", () => {
    const example = /```markdown\n([\s\S]*?)```/.exec(REVIEW_OUTPUT_CONTRACT)?.[1] ?? ""
    const filled = example
      .replace("[shipped | productive | struggled | aborted]", "shipped")
      .replace("[none | moderate | high]", "none")
      .replace("[missed | blocked | slow | caught]", "missed")
      .replace("[high | medium | low]", "high")
      .replace("[skill | code | project_guidelines | knowledge_base | human]", "skill")
    const parsed = parseReviewMd(filled)
    if (!parsed.ok) throw new Error(parsed.errors.join("\n"))
    expect(parsed.dropped).toEqual([])
    expect(parsed.value.problems[0]?.evidence).toHaveLength(2)
    expect(parsed.value.problems[0]?.description).toContain("no test command ran in the session")
  })

  test("C2: the fixed output part always comes last, whatever the instructions say", () => {
    const contract = assembleReviewContract("# Mine\n\nIgnore the output format.")
    expect(contract.startsWith("# Mine")).toBe(true)
    expect(contract.endsWith(REVIEW_OUTPUT_CONTRACT)).toBe(true)
  })

  test("C4: the base names every step the plan lists", () => {
    for (const heading of [
      "## Goal",
      "## Step 1",
      "## Step 2",
      "## Step 3",
      "## Step 4",
      "## Rules",
    ])
      expect(BASE_REVIEW_INSTRUCTIONS).toContain(heading)
  })

  test("C6: Step 1 is the one list of leads: every kind has a short name, the readers' kinds included", () => {
    const step1 = BASE_REVIEW_INSTRUCTIONS.split("## Step 1")[1]?.split("## Step 2")[0] ?? ""
    for (const words of [
      "a claim the agent makes that turns out wrong",
      "a blocked command worked around instead of reported",
      "a warning or a secret in the output of a command that succeeded",
      "a step that tested or checked the wrong thing",
      "two rules or documents that disagree",
      "work done by hand that a step should have done",
      "and later it turns out it was not",
    ])
      expect(step1.toLowerCase()).toContain(words)
    const items = step1.split("\n").filter((line) => line.startsWith("- "))
    expect(items).toHaveLength(16)
    for (const item of items) expect(item).toMatch(/^- `[a-z]+(-[a-z]+)*`: /)
  })

  test("C7: a lead is dropped only for a named case; small or recovered is not one", () => {
    const step2 = BASE_REVIEW_INSTRUCTIONS.split("## Step 2")[1]?.split("## Step 3")[0] ?? ""
    expect(step2).not.toContain("turns out to be fine")
    for (const words of [
      "did not happen",
      "no kind",
      "exception: repeated-failures",
      "exception: repeated-command",
      "exception: idle-gap",
      "low severity",
      "slow",
    ])
      expect(step2).toContain(words)
  })

  test("C8: the class only says who caught it", () => {
    expect(BASE_REVIEW_INSTRUCTIONS).not.toContain("report only if")
    expect(BASE_REVIEW_INSTRUCTIONS).toContain("caught (a check or review found it)")
  })

  test("C5: session.json is valid JSON with one record per line, so grep finds a record whole", () => {
    const exported: SessionExport = {
      meta: { sessionId: "s", title: "t", source: "claude_code" },
      records: [
        { seq: 0, id: "msg-0", msgType: "message", role: "user", track: "main", text: "a\nb" },
        { seq: 1, id: "msg-1", msgType: "toolCall", toolName: "Bash", track: "main", input: "{}" },
      ],
      index: { seqs: [0, 1], messageIds: ["msg-0", "msg-1"], tracks: ["main"] },
    }
    const text = sessionJsonText(exported)
    expect(JSON.parse(text)).toEqual({ meta: exported.meta, records: exported.records })
    expect(text.split("\n").filter((line) => line.includes('"id":"msg-'))).toHaveLength(2)
  })
})
