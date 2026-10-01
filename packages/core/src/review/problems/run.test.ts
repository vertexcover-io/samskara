import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "vitest"
import type { SessionExport, SessionExportRecord } from "../lenses/export.js"
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
  const runCheck = (answers: string): { code: number; out: string } => {
    const dir = mkdtempSync(join(tmpdir(), "rr-check-"))
    try {
      const { files } = problemReviewFiles(exported, "# How to review")
      for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text)
      writeFileSync(join(dir, "leads-answered.md"), answers)
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
    expect(runCheck("  - L1: problem — Claimed tests passed\n")).toEqual({
      code: 0,
      out: "All 1 leads accounted for.\n",
    })
  })

  test("RR8b: check.mjs lets the person's message be dropped only by quoting that message", () => {
    // L1 is the person's "fix the build", msg-0.
    const unquoted = {
      code: 1,
      out: 'Human messages dropped without quoting the message itself: L1. Write - L1: dropped — msg-N — "their exact words" — why it is an ordinary answer\n',
    }
    expect(runCheck("- L1: dropped — fine\n")).toEqual(unquoted)
    expect(runCheck('- L1: dropped — msg-1 — "all tests pass" — the agent said so\n')).toEqual(
      unquoted,
    )
    expect(runCheck('- L1: dropped — msg-0 — "something else" — the ask\n')).toEqual(unquoted)
    expect(runCheck('- L1: dropped — msg-0 — "Fix the build" — the opening ask\n')).toEqual({
      code: 0,
      out: "All 1 leads accounted for.\n",
    })
  })

  test("RR9: code agrees with check.mjs on which leads the review skipped", () => {
    const read = (leadAnswers?: string) =>
      readProblemReview(reviewMd("all tests pass"), exported.records, {
        leadIds: ["L1", "L2"],
        ...(leadAnswers === undefined ? {} : { leadAnswers }),
      })
    const none = read()
    expect(none.ok && none.unaccountedLeads).toEqual(["L1", "L2"])
    const some = read("  - L1: dropped — fine\n")
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
    expect(read("- L1: dropped — fine\n")).toEqual(["L1"])
    expect(read('- L1: dropped — msg-1 — "all tests pass" — the agent said so\n')).toEqual(["L1"])
    expect(read('- L1: dropped — msg-0 — "fix the build" — the opening ask\n')).toEqual([])
    expect(read("- L1: problem — Claimed tests passed\n")).toEqual([])
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
      run: async ({ workspaceDir: dir }) => {
        runs.push(readFileSync(join(dir, "READER.md"), "utf8").slice(0, 20))
        writeFileSync(join(dir, "leads.md"), '- msg-1 — "all tests pass" — nothing ran first')
        return { stdout: "done", firstByteMs: 1 }
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
        "leads-answered.md": '- L1: dropped — msg-0 — "fix the build" — the opening ask\n',
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
