import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "vitest"
import type { SessionExport, SessionExportRecord } from "../export.js"
import type { HarnessRunner } from "../runner.js"
import { REVIEW_OUTPUT_CONTRACT, reviewMdSkeleton } from "./contract.js"
import {
  MAX_EXTRA_FIELDS,
  MAX_REVIEW_MD_BYTES,
  type PreparedProblems,
  prepareProblems,
  problemReviewFiles,
  readProblemReview,
  readProblemWorkspace,
  requiredExtraFields,
} from "./run.js"

const exported: SessionExport = {
  meta: { sessionId: "s", title: "Fix the build", source: "claude_code" },
  records: [
    { seq: 0, id: "msg-0", msgType: "message", role: "user", track: "main", text: "fix the build" },
    {
      seq: 1,
      id: "msg-1",
      msgType: "message",
      role: "assistant",
      track: "main",
      text: "all tests pass",
    },
  ],
  index: { seqs: [0, 1], messageIds: ["msg-0", "msg-1"], tracks: ["main"] },
}

const reviewMd = (quote: string) => `# Review

- **Outcome:** shipped
- **Friction:** none

## Summary

Short.

## Problems

### Claimed tests passed

- **Class:** missed
- **Severity:** high — a wrong result would ship
- **Fix type:** skill
- **Description:** Expected a test run. None happened.
- **Evidence:** msg-1 — "${quote}" — this is wrong: no test ran.
- **Learning:** Run the tests first.
`

describe("problem review run", () => {
  test("RR1: the reviewer is handed the session, the contract, the leads, the lead check and an empty review.md", () => {
    const { files, prompt } = problemReviewFiles(
      exported,
      "# How to review\n\nmine",
      "- L1 found\n",
    )
    expect(Object.keys(files)).toEqual([
      "session.json",
      "CONTRACT.md",
      "leads.md",
      "leads-answered.md",
      "check.mjs",
      "review.md",
    ])
    expect(files["CONTRACT.md"]?.startsWith("# How to review\n\nmine")).toBe(true)
    expect(files["CONTRACT.md"]?.endsWith(REVIEW_OUTPUT_CONTRACT)).toBe(true)
    expect(files["leads.md"]).toBe("- L1 found\n")
    expect(prompt).toContain("Fix the build")
  })

  test("RR1b: without readers' leads (a dry run), leads.md holds what code finds", () => {
    expect(problemReviewFiles(exported, "# How to review").files["leads.md"]).toContain(
      "fix the build",
    )
  })

  test("RR2: a good review comes back with its problems and nothing dropped", () => {
    const result = readProblemReview(reviewMd("all tests pass"), exported.records)
    expect(result.ok && result.review.problems).toHaveLength(1)
    expect(result.ok && result.dropped).toEqual([])
  })

  test("RR3: a problem whose quote is not in the session is dropped, the review is kept", () => {
    const result = readProblemReview(reviewMd("something else"), exported.records)
    expect(result.ok && result.review.problems).toEqual([])
    expect(result.ok && result.dropped).toEqual([
      '"Claimed tests passed": "something else" is not in msg-1',
    ])
  })

  test("RR4: an oversized or unreadable review.md fails whole", () => {
    expect(readProblemReview("x".repeat(MAX_REVIEW_MD_BYTES + 1), exported.records)).toMatchObject({
      ok: false,
    })
    expect(readProblemReview("", exported.records)).toMatchObject({ ok: false })
  })
})

describe("leads the reviewer must answer", () => {
  /** Runs the staged check.mjs against `answers`, the way the reviewer does. */
  const runCheck = (
    answers: string,
    session: SessionExport = exported,
    review: string = reviewMd("all tests pass"),
  ): { code: number; out: string } => {
    const dir = mkdtempSync(join(tmpdir(), "rr-check-"))
    try {
      const { files } = problemReviewFiles(session, "# How to review")
      for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text)
      writeFileSync(join(dir, "leads-answered.md"), answers)
      writeFileSync(join(dir, "review.md"), review)
      try {
        return { code: 0, out: execFileSync("node", ["check.mjs"], { cwd: dir, encoding: "utf8" }) }
      } catch (error) {
        const failed = error as { status: number; stdout: string }
        return { code: failed.status, out: failed.stdout }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  test("RR8: check.mjs names the leads not yet answered, and accepts an indented answer", () => {
    // Code finds one lead here: the person's "fix the build".
    expect(runCheck("")).toEqual({ code: 1, out: "Not yet answered in leads-answered.md: L1\n" })
    expect(runCheck("  - L1: problem (kind: false-done) — Claimed tests passed\n")).toEqual({
      code: 0,
      out: "All 1 leads accounted for.\n",
    })
  })

  test("RR8e: check.mjs counts a problem answer only in full form, naming a problem in review.md", () => {
    const noProblem = {
      code: 1,
      out: "Problem answers that do not name a problem in review.md: L1. Write - L1: problem (kind: <kind>) — <the ### title of its problem in review.md>\n",
    }
    expect(runCheck("- L1: problem\n")).toEqual(noProblem)
    expect(runCheck("- L1: problem — Claimed tests passed\n")).toEqual(noProblem)
    expect(runCheck("- L1: problem (kind: false-done) — Something else\n")).toEqual(noProblem)
    expect(
      runCheck(
        "- L1: problem (kind: false-done) — Claimed tests passed\n",
        exported,
        reviewMd("all tests pass").replace("## Problems", "## Summary2"),
      ).code,
    ).toBe(1)
    expect(runCheck("- L1: problem (kind: false-done) — claimed  TESTS passed\n").code).toBe(0)
  })

  test("RR8f: check.mjs rejects a Problems section with no problem that does not say Nothing to change", () => {
    const answered = '- L1: dropped (no kind) — msg-0 — "Fix the build" — the opening ask\n'
    const withProblems = (text: string) =>
      reviewMd("all tests pass").replace(/## Problems[\s\S]*/, `## Problems\n\n${text}\n`)
    expect(runCheck(answered, exported, withProblems("I could not finish the review"))).toEqual({
      code: 1,
      out: "## Problems has no ### problem and does not start with Nothing to change.\n",
    })
    expect(runCheck(answered, exported, withProblems("Nothing to change. All okay.")).code).toBe(0)
  })

  test("RR8b: check.mjs lets the person's message be dropped only by quoting that message", () => {
    // L1 is the person's "fix the build", msg-0.
    const unquoted = {
      code: 1,
      out: 'Human messages dropped without quoting the message itself: L1. Write - L1: dropped (<case>) — msg-0 — "their exact words" — why it is an ordinary answer\n',
    }
    expect(runCheck("- L1: dropped (did not happen) — fine\n")).toEqual(unquoted)
    expect(
      runCheck('- L1: dropped (no kind) — msg-1 — "all tests pass" — the agent said so\n'),
    ).toEqual(unquoted)
    expect(runCheck('- L1: dropped (no kind) — msg-0 — "something else" — the ask\n')).toEqual(
      unquoted,
    )
    expect(
      runCheck('- L1: dropped (no kind) — msg-0 — "Fix the build" — the opening ask\n'),
    ).toEqual({
      code: 0,
      out: "All 1 leads accounted for.\n",
    })
  })

  /** A session whose one code lead is not the person's: a command failing three times. */
  const failing: SessionExport = {
    ...exported,
    records: [0, 1, 2].map((n) => ({
      seq: n,
      id: `msg-${n}`,
      msgType: "toolCall" as const,
      toolName: "Bash",
      track: "main",
      input: "bun test",
      status: "failure" as const,
      output: "1 failed",
    })),
  }
  const noCase = {
    code: 1,
    out: "Drops that name no case: L1. Write - L1: dropped (did not happen | no kind | exception: repeated-failures | exception: repeated-command | exception: idle-gap) — why\n",
  }

  test("RR8d: check.mjs rejects a drop that names no case, and accepts each case", () => {
    // Code finds five leads in `failing`; the rest are answered so only L1's answer counts.
    const rest = ["L2", "L3", "L4", "L5"].map(
      (id) => `- ${id}: dropped (no kind) — msg-1 — "1 failed" — ${id} failed as planned\n`,
    )
    const checkL1 = (answer: string, session: SessionExport) =>
      runCheck(`${answer}${rest.join("")}`, session)
    expect(checkL1("- L1: dropped — minor\n", failing)).toEqual(noCase)
    expect(checkL1("- L1: dropped (minor) — small\n", failing)).toEqual(noCase)
    expect(checkL1("- L1: dropped (exception: whatever) — small\n", failing)).toEqual(noCase)
    for (const kase of [
      "did not happen",
      "no kind",
      "exception: repeated-failures",
      "exception: repeated-command",
      "exception: idle-gap",
    ])
      expect(
        checkL1(`- L1: dropped (${kase}) — msg-0 — "bun test" — the red step\n`, failing).code,
      ).toBe(0)
    expect(
      checkL1("- L1: problem (kind: repeated-failures) — Claimed tests passed\n", failing).code,
    ).toBe(0)
  })

  test("RR9d: code agrees with check.mjs: a drop must name its case", () => {
    const read = (leadAnswers: string) => {
      const result = readProblemReview(reviewMd("all tests pass"), exported.records, {
        leadIds: ["L1"],
        leadAnswers,
      })
      return result.ok && result.unaccountedLeads
    }
    expect(read("- L1: dropped — minor\n")).toEqual(["L1"])
    expect(read("- L1: dropped (minor) — small\n")).toEqual(["L1"])
    expect(read("- L1: dropped (exception: whatever) — small\n")).toEqual(["L1"])
    expect(
      read('- L1: dropped (exception: idle-gap) — msg-1 — "all tests pass" — the turn had ended\n'),
    ).toEqual([])
    expect(
      read('- L1: dropped (did not happen) — msg-1 — "all tests pass" — no such failure\n'),
    ).toEqual([])
    expect(read("- L1: problem (kind: false-done) — Claimed tests passed\n")).toEqual([])
  })

  test("RR9e: code agrees with check.mjs: a problem answer must name a problem the review kept", () => {
    const read = (leadAnswers: string, quote = "all tests pass") => {
      const result = readProblemReview(reviewMd(quote), exported.records, {
        leadIds: ["L1"],
        leadAnswers,
      })
      return result.ok && result.unaccountedLeads
    }
    expect(read("- L1: problem\n")).toEqual(["L1"])
    expect(read("- L1: problem — Claimed tests passed\n")).toEqual(["L1"])
    expect(read("- L1: problem (kind: false-done) — Something else\n")).toEqual(["L1"])
    // The problem is in review.md, but its quote is not in the session, so it was thrown away.
    expect(read("- L1: problem (kind: false-done) — Claimed tests passed\n", "never said")).toEqual(
      ["L1"],
    )
  })

  test("RR9: code agrees with check.mjs on which leads the review skipped", () => {
    const read = (leadAnswers?: string) =>
      readProblemReview(reviewMd("all tests pass"), exported.records, {
        leadIds: ["L1", "L2"],
        ...(leadAnswers === undefined ? {} : { leadAnswers }),
      })
    const none = read()
    expect(none.ok && none.unaccountedLeads).toEqual(["L1", "L2"])
    const some = read("  - L1: dropped (did not happen) — fine\n")
    expect(some.ok && some.unaccountedLeads).toEqual(["L2"])
  })

  test("RR9b: code agrees with check.mjs: a dropped human message must quote that message", () => {
    const read = (leadAnswers: string) => {
      const result = readProblemReview(reviewMd("all tests pass"), exported.records, {
        leadIds: ["L1"],
        humanLeads: [{ id: "L1", msgId: "msg-0" }],
        leadAnswers,
      })
      return result.ok && result.unaccountedLeads
    }
    expect(read("- L1: dropped (did not happen) — fine\n")).toEqual(["L1"])
    expect(
      read('- L1: dropped (no kind) — msg-1 — "all tests pass" — the agent said so\n'),
    ).toEqual(["L1"])
    expect(read('- L1: dropped (no kind) — msg-0 — "fix the build" — the opening ask\n')).toEqual(
      [],
    )
    expect(read("- L1: problem (kind: false-done) — Claimed tests passed\n")).toEqual([])
  })
})

describe("extra fields the instructions ask for", () => {
  const instructions = `# How to review

## Goal

Find problems.

## Extra fields

- topic: what the person was asking about.
- \`stage\`: which step it happened in.

## Step 1: find leads
`

  test("RR5: the field names are read from the instructions' Extra fields section", () => {
    expect(requiredExtraFields(instructions)).toEqual(["topic", "stage"])
    expect(requiredExtraFields("# How to review\n\n## Goal\n")).toEqual([])
  })

  test("RR6: a problem missing a required extra field is dropped, one that has them is kept", () => {
    const withExtra = reviewMd("all tests pass").replace(
      "- **Learning:** Run the tests first.",
      "- **Learning:** Run the tests first.\n- **Extra:** topic: the build; stage: coder",
    )
    const kept = readProblemReview(withExtra, exported.records, { extraFields: ["topic", "stage"] })
    expect(kept.ok && kept.review.problems).toHaveLength(1)

    const missing = readProblemReview(reviewMd("all tests pass"), exported.records, {
      extraFields: ["topic"],
    })
    expect(missing.ok && missing.review.problems).toEqual([])
    expect(missing.ok && missing.dropped).toEqual(['"Claimed tests passed": missing Extra "topic"'])
  })

  test("RR7: names are cleaned of markdown and case; a name that is not one short word is refused", () => {
    expect(
      requiredExtraFields("## Extra fields\n\n- **Stage**: which step\n- `Topic`: what\n"),
    ).toEqual(["stage", "topic"])
    expect(() => requiredExtraFields("## Extra fields\n\n- which step it was: x\n")).toThrow(
      "not a field name",
    )
    const tooMany = Array.from({ length: MAX_EXTRA_FIELDS + 1 }, (_, i) => `- f${i}: x`).join("\n")
    expect(() => requiredExtraFields(`## Extra fields\n\n${tooMany}\n`)).toThrow(
      `more than ${MAX_EXTRA_FIELDS}`,
    )
  })
})

describe("prepareProblems", () => {
  const records: SessionExportRecord[] = [
    {
      seq: 0,
      id: "msg-0",
      msgType: "message",
      role: "user",
      track: "main",
      ts: 0,
      text: "fix the build",
    },
    {
      seq: 1,
      id: "msg-1",
      msgType: "message",
      role: "assistant",
      track: "main",
      ts: 1000,
      text: "all tests pass",
    },
    {
      seq: 2,
      id: "msg-2",
      msgType: "message",
      role: "user",
      track: "main",
      ts: 2000,
      text: "why did you stop ?",
    },
  ]
  const session: SessionExport = {
    meta: { sessionId: "s", title: "t", source: "claude_code" },
    records,
    index: { seqs: [0, 1, 2], messageIds: ["msg-0", "msg-1", "msg-2"], tracks: ["main"] },
  }

  test("ST1: readers read the session, and their leads come first in leads.md, before code's", async () => {
    const runs: string[] = []
    const runner: HarnessRunner = {
      run: async ({ prompt }) => {
        runs.push(prompt.slice(0, 20))
        return { stdout: '- msg-1 — "all tests pass" — nothing ran first', firstByteMs: 1 }
      },
    }
    const result = await prepareProblems({
      exported: session,
      instructions: "# How to review",
      runner,
    })
    expect(runs).toHaveLength(1)
    expect(result.found.pieceCount).toBe(1)
    expect(result.found.leads).toHaveLength(1)
    expect(result.leadsMd.indexOf("nothing ran first")).toBeLessThan(
      result.leadsMd.indexOf("why did you stop"),
    )
    expect(result.leadIds[0]).toBe("L1")
    expect(result.leadIds.length).toBeGreaterThan(1)
  })
})

describe("readProblemWorkspace", () => {
  const prepared: PreparedProblems = {
    found: {
      leads: [],
      dropped: ["main, part 1: msg-9: no such message"],
      failedPieces: ["helper a: timed out"],
      pieceCount: 2,
    },
    leadsMd: "",
    leadIds: ["L1", "L2"],
    humanLeads: [{ id: "L1", msgId: "msg-0" }],
  }
  /** Runs `work` on a workspace holding `files`, then removes it. */
  const withFiles = async <T>(
    files: Record<string, string>,
    work: (dir: string) => Promise<T>,
  ): Promise<T> => {
    const dir = mkdtempSync(join(tmpdir(), "rr-workspace-"))
    try {
      for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text)
      return await work(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
  const read = (workspaceDir: string, instructions = "# How to review") =>
    readProblemWorkspace({ workspaceDir, records: exported.records, instructions, prepared })

  test("RW1: reads review.md and leads-answered.md, checks them against the leads, and sums up the readers", async () => {
    const read1 = await withFiles(
      {
        "review.md": reviewMd("all tests pass"),
        "leads-answered.md":
          '- L1: dropped (no kind) — msg-0 — "fix the build" — the opening ask\n',
      },
      read,
    )
    expect(read1.markdown).toBe(reviewMd("all tests pass"))
    expect(read1.leadAnswers).toContain("- L1: dropped")
    expect(read1.readers).toEqual({
      pieces: 2,
      leads: 0,
      dropped: ["main, part 1: msg-9: no such message"],
      failedPieces: ["helper a: timed out"],
    })
    if (read1.markdown === null) throw new Error("expected a review")
    expect(read1.result).toMatchObject({ ok: true, unaccountedLeads: ["L2"] })
  })

  test("RW2: a missing or untouched review.md reads as no review; leads-answered.md defaults to empty", async () => {
    const missing = await withFiles({}, read)
    expect(missing).toMatchObject({ markdown: null, leadAnswers: "" })
    const untouched = await withFiles({ "review.md": reviewMdSkeleton() }, read)
    expect(untouched.markdown).toBeNull()
  })

  test("RW3: the extra fields the instructions ask for are required", async () => {
    const result = await withFiles({ "review.md": reviewMd("all tests pass") }, (dir) =>
      read(dir, "## Extra fields\n\n- topic: what it was about\n"),
    )
    if (result.markdown === null) throw new Error("expected a review")
    expect(result.result.ok && result.result.dropped).toEqual([
      '"Claimed tests passed": missing Extra "topic"',
    ])
  })

  test("RW4: a review.md past the size cap is refused, not cut to fit", async () => {
    const result = await withFiles(
      { "review.md": reviewMd("all tests pass") + "x".repeat(MAX_REVIEW_MD_BYTES) },
      read,
    )
    if (result.markdown === null) throw new Error("expected a review")
    expect(result.result).toMatchObject({ ok: false })
  })
})
