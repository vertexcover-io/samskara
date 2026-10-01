import { describe, expect, test } from "vitest"
import type { SessionExportRecord } from "../lenses/export.js"
import { checkEvidence, LIMITS, parseReviewMd } from "./reviewMd.js"

const problem = (title: string, fields: Record<string, string>): string =>
  [
    `### ${title}`,
    "",
    ...Object.entries({
      Class: "missed",
      Severity: "high — a wrong result would have shipped",
      "Fix type": "skill",
      Description:
        "The agent was expected to run the tests before reporting. It reported them as passing without running them.",
      Evidence: 'msg-2 — "all tests pass" — this is wrong: no test command ran before it.',
      Learning: "Run the test command and read its result before saying tests pass.",
      ...fields,
    }).map(([name, value]) => `- **${name}:** ${value}`),
    "",
  ].join("\n")

const review = (...problems: string[]): string => `# Review

- **Outcome:** shipped
- **Friction:** moderate

## Summary

The agent fixed the build after two wrong starts.

## Problems

${problems.join("\n")}`

const records: SessionExportRecord[] = [
  {
    seq: 0,
    id: "msg-0",
    msgType: "message",
    role: "user",
    track: "main",
    text: "no, use port 7169 not 7100",
  },
  { seq: 1, id: "msg-1", msgType: "message", role: "assistant", track: "main", text: "Done —" },
  {
    seq: 2,
    id: "msg-2",
    msgType: "message",
    role: "assistant",
    track: "main",
    text: "all tests  pass.",
  },
  {
    seq: 3,
    id: "msg-3",
    msgType: "toolCall",
    toolName: "Bash",
    track: "main",
    input: '{"command":"bun test"}',
  },
]

describe("parseReviewMd", () => {
  test("RM1: reads the header, the summary and every field of a problem", () => {
    const parsed = parseReviewMd(
      review(
        problem("Said tests passed without running them", {
          Evidence:
            'msg-1 to msg-2 — "all tests pass" — this is wrong: no test command ran before it.',
          Extra: "stage: coder; tool: bash",
        }),
      ),
    )
    if (!parsed.ok) throw new Error(parsed.errors.join("\n"))
    expect(parsed.value).toMatchObject({ outcome: "shipped", friction: "moderate" })
    expect(parsed.value.summary).toBe("The agent fixed the build after two wrong starts.")
    expect(parsed.dropped).toEqual([])
    expect(parsed.value.problems).toEqual([
      {
        title: "Said tests passed without running them",
        class: "missed",
        severity: "high",
        severityReason: "a wrong result would have shipped",
        fixType: "skill",
        description:
          "The agent was expected to run the tests before reporting. It reported them as passing without running them.",
        evidence: [
          {
            from: "msg-1",
            to: "msg-2",
            quote: "all tests pass",
            why: "this is wrong: no test command ran before it.",
          },
        ],
        learning: "Run the test command and read its result before saying tests pass.",
        extra: { stage: "coder", tool: "bash" },
      },
    ])
  })

  test("RM2: every fix type is accepted, whatever its case", () => {
    const types = ["Skill", "code", "Project_Guidelines", "knowledge_base", "Human"]
    const parsed = parseReviewMd(
      review(...types.map((type, i) => problem(`P${i}`, { "Fix type": type }))),
    )
    expect(parsed.ok && parsed.value.problems.map((p) => p.fixType)).toEqual([
      "skill",
      "code",
      "project_guidelines",
      "knowledge_base",
      "human",
    ])
  })

  test("RM3: 'Nothing to change' under Problems is an empty list", () => {
    const parsed = parseReviewMd(review("Nothing to change."))
    expect(parsed.ok && parsed.value.problems).toEqual([])
  })

  test("RM4: a broken problem is dropped with its reasons, and the rest of the review is kept", () => {
    const parsed = parseReviewMd(
      review(problem("Good one", {}), problem("Bad one", { Class: "sometimes", Learning: "" })),
    )
    if (!parsed.ok) throw new Error(parsed.errors.join("\n"))
    expect(parsed.value.problems.map((p) => p.title)).toEqual(["Good one"])
    expect(parsed.dropped).toEqual([
      '"Bad one": missing Learning',
      '"Bad one": Class must be one of missed, blocked, slow, caught, not "sometimes"',
    ])
  })

  test("RM5: evidence without a reason, or not in the msg-N shape, drops the problem", () => {
    const parsed = parseReviewMd(
      review(
        problem("No reason", { Evidence: 'msg-2 — "all tests pass"' }),
        problem("No id", { Evidence: 'somewhere — "all tests pass" — wrong' }),
      ),
    )
    if (!parsed.ok) throw new Error(parsed.errors.join("\n"))
    expect(parsed.value.problems).toEqual([])
    expect(parsed.dropped.join("\n")).toContain('"No reason": Evidence must read')
    expect(parsed.dropped.join("\n")).toContain('"No id": Evidence must read')
  })

  test("RM6: a field over its length limit drops the problem and says the limit", () => {
    const parsed = parseReviewMd(review(problem("x".repeat(LIMITS.title + 1), {})))
    if (!parsed.ok) throw new Error(parsed.errors.join("\n"))
    expect(parsed.value.problems).toEqual([])
    expect(parsed.dropped[0]).toContain(`Title is longer than ${LIMITS.title} characters`)
  })

  test("RM7: problems past the count limit are dropped, not all of them", () => {
    const many = Array.from({ length: LIMITS.problems + 2 }, (_, i) => problem(`P${i}`, {}))
    const parsed = parseReviewMd(review(...many))
    if (!parsed.ok) throw new Error(parsed.errors.join("\n"))
    expect(parsed.value.problems).toHaveLength(LIMITS.problems)
    expect(parsed.dropped).toEqual([`2 problems past the limit of ${LIMITS.problems}`])
  })

  test("RM8: a missing or wrong header fails the whole review", () => {
    const parsed = parseReviewMd("not a review at all")
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.errors.join("\n")).toContain("missing ## Summary")
  })
})

describe("checkEvidence", () => {
  const parse = (text: string) => {
    const parsed = parseReviewMd(text)
    if (!parsed.ok) throw new Error(parsed.errors.join("\n"))
    return parsed.value
  }

  test("RM9: quotes found at their ids pass, whitespace and case aside", () => {
    const result = checkEvidence(parse(review(problem("Fine", {}))), records)
    expect(result.dropped).toEqual([])
    expect(result.review.problems).toHaveLength(1)
  })

  test("RM10: an unknown id, a backwards range or a quote not in range drops that problem only", () => {
    const result = checkEvidence(
      parse(
        review(
          problem("Backwards", { Evidence: 'msg-2 to msg-1 — "all tests pass" — wrong' }),
          problem("Unknown", { Evidence: 'msg-99 — "bun test" — wrong' }),
          problem("Not there", { Evidence: 'msg-0 — "use port 8000" — wrong' }),
          problem("Fine", {}),
        ),
      ),
      records,
    )
    expect(result.review.problems.map((p) => p.title)).toEqual(["Fine"])
    expect(result.dropped).toEqual([
      '"Backwards": msg-2 to msg-1: range runs backwards',
      '"Unknown": msg-99: no such message',
      '"Not there": "use port 8000" is not in msg-0',
    ])
  })

  test("RM11: a quote shortened with an ellipsis matches when each piece is there", () => {
    const result = checkEvidence(
      parse(
        review(
          problem("Fine", {
            Evidence: 'msg-0 — "no, use … not 7100" — the person corrected the port.',
          }),
        ),
      ),
      records,
    )
    expect(result.dropped).toEqual([])
  })

  test("RM12: a quote copied with the JSON escapes session.json shows still matches", () => {
    const quoted: SessionExportRecord[] = [
      {
        seq: 0,
        id: "msg-0",
        msgType: "message",
        role: "user",
        track: "main",
        text: 'he said "check the repo" twice',
      },
    ]
    const result = checkEvidence(
      parse(
        review(
          problem("Escaped", {
            Evidence: String.raw`msg-0 — "\"check the repo\"" — the ask was repeated.`,
          }),
        ),
      ),
      quoted,
    )
    expect(result.dropped).toEqual([])
  })

  test("RM13: an empty, ellipsis-only or one-letter quote is not proof", () => {
    const result = checkEvidence(
      parse(
        review(
          problem("Empty", { Evidence: 'msg-2 — "…" — wrong' }),
          problem("Dots", { Evidence: 'msg-2 — "..." — wrong' }),
          problem("Letter", { Evidence: 'msg-2 — "a" — wrong' }),
          problem("Short word", { Evidence: 'msg-1 — "Done" — the whole reply' }),
        ),
      ),
      records,
    )
    expect(result.review.problems.map((p) => p.title)).toEqual(["Short word"])
    expect(result.dropped).toEqual([
      '"Empty": msg-2: the quote is too short to prove anything',
      '"Dots": msg-2: the quote is too short to prove anything',
      '"Letter": msg-2: the quote is too short to prove anything',
    ])
  })

  test("RM14: a range wider than the limit is refused, so a common word cannot match anywhere", () => {
    const many: SessionExportRecord[] = Array.from(
      { length: LIMITS.evidenceRange + 2 },
      (_, seq) => ({
        seq,
        id: `msg-${seq}`,
        msgType: "message",
        role: "assistant",
        track: "main",
        text: seq === LIMITS.evidenceRange + 1 ? "the build" : "x",
      }),
    )
    const result = checkEvidence(
      parse(
        review(
          problem("Wide", {
            Evidence: `msg-0 to msg-${LIMITS.evidenceRange + 1} — "the build" — wrong`,
          }),
        ),
      ),
      many,
    )
    expect(result.dropped).toEqual([
      `"Wide": msg-0 to msg-${LIMITS.evidenceRange + 1}: range is wider than ${LIMITS.evidenceRange} messages`,
    ])
  })
})

describe("parseReviewMd, forgiving where the meaning is clear", () => {
  test("RM15: a range written with a dash, and curly quotes, both parse", () => {
    const parsed = parseReviewMd(
      review(
        problem("Dash", { Evidence: 'msg-1–msg-2 — "all tests pass" — wrong' }),
        problem("Hyphen", { Evidence: "msg-1-msg-2 — “all tests pass” — wrong" }),
      ),
    )
    expect(parsed.ok && parsed.dropped).toEqual([])
    expect(parsed.ok && parsed.value.problems.map((p) => p.evidence[0])).toEqual([
      { from: "msg-1", to: "msg-2", quote: "all tests pass", why: "wrong" },
      { from: "msg-1", to: "msg-2", quote: "all tests pass", why: "wrong" },
    ])
  })

  test("RM16: a long summary is cut to its limit and noted, the review is kept", () => {
    const long = review(problem("Kept", {})).replace(
      "The agent fixed the build after two wrong starts.",
      "y".repeat(LIMITS.summary + 50),
    )
    const parsed = parseReviewMd(long)
    if (!parsed.ok) throw new Error(parsed.errors.join("\n"))
    expect(parsed.value.summary).toHaveLength(LIMITS.summary)
    expect(parsed.value.problems).toHaveLength(1)
    expect(parsed.dropped).toEqual([`Summary cut to ${LIMITS.summary} characters`])
  })

  test("RM17: extra field names are read case-insensitively; a pair without a colon is named", () => {
    const parsed = parseReviewMd(
      review(
        problem("Case", { Extra: "Stage: coder" }),
        problem("No colon", { Extra: "stage coder" }),
      ),
    )
    if (!parsed.ok) throw new Error(parsed.errors.join("\n"))
    expect(parsed.value.problems.map((p) => p.extra)).toEqual([{ stage: "coder" }])
    expect(parsed.dropped).toEqual(['"No colon": Extra must read name: value, not "stage coder"'])
  })

  test("RM18: a wrapped line that is not indented still belongs to its field", () => {
    const parsed = parseReviewMd(
      review(problem("Wrapped", {})).replace(
        "- **Learning:** Run the test command and read its result before saying tests pass.",
        "- **Learning:** Run the test command and read its result\nbefore saying tests pass.",
      ),
    )
    expect(parsed.ok && parsed.value.problems[0]?.learning).toBe(
      "Run the test command and read its result before saying tests pass.",
    )
  })

  test("RM19: a value with a semicolon in it stays one value, not a broken field", () => {
    const parsed = parseReviewMd(
      review(
        problem("Semicolon", { Extra: "topic: recurrence flow; parent-field rule; stage: plan" }),
      ),
    )
    expect(parsed.ok && parsed.dropped).toEqual([])
    expect(parsed.ok && parsed.value.problems[0]?.extra).toEqual({
      topic: "recurrence flow; parent-field rule",
      stage: "plan",
    })
  })

  test("RM20: Evidence is one heading with each message listed under it", () => {
    const parsed = parseReviewMd(
      review(problem("Listed", {})).replace(
        '- **Evidence:** msg-2 — "all tests pass" — this is wrong: no test command ran before it.',
        [
          "- **Evidence:**",
          '  - msg-2 — "all tests pass" — this is wrong: no test command ran before it.',
          '  - msg-0 to msg-1 — "use port 7169" — the person had to give the port.',
        ].join("\n"),
      ),
    )
    if (!parsed.ok) throw new Error(parsed.errors.join("\n"))
    expect(parsed.dropped).toEqual([])
    expect(parsed.value.problems[0]?.evidence).toEqual([
      {
        from: "msg-2",
        to: "msg-2",
        quote: "all tests pass",
        why: "this is wrong: no test command ran before it.",
      },
      {
        from: "msg-0",
        to: "msg-1",
        quote: "use port 7169",
        why: "the person had to give the port.",
      },
    ])
    // The listed items belong to Evidence, not to the field before it.
    expect(parsed.value.problems[0]?.description).not.toContain("msg-")
  })

  test("RM21: a quote that has quote marks of its own still parses", () => {
    const parsed = parseReviewMd(
      review(
        problem("Inner quotes", { Evidence: 'msg-2 — "over":157 — the phone view overflowed' }),
      ),
    )
    expect(parsed.ok && parsed.dropped).toEqual([])
    expect(parsed.ok && parsed.value.problems[0]?.evidence[0]).toEqual({
      from: "msg-2",
      to: "msg-2",
      quote: '"over":157',
      why: "the phone view overflowed",
    })
  })
})
