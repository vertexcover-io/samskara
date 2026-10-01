import { describe, expect, test } from "vitest"
import type { SessionExport } from "../lenses/export.js"
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
