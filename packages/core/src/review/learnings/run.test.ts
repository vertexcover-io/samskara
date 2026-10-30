import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import type { HarnessRunner } from "../runner.js"
import { cloneHarness, groupProblems, snapshotHarness, writeLearnings } from "./run.js"
import type { LearningInput, ProblemInput } from "./types.js"

const problem = (id: string): ProblemInput => ({
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
})

/** A fake agent: writes `file` into its workspace, after checking what it was handed. */
const agent = (
  file: string,
  text: string,
  seen: { dir?: string; files?: string[] } = {},
): HarnessRunner => ({
  run: async ({ workspaceDir }) => {
    seen.dir = workspaceDir
    seen.files = [
      "CONTRACT.md",
      "problems.md",
      "known-learnings.md",
      "groups.md",
      "check.mjs",
      "harness",
    ].filter((name) => existsSync(join(workspaceDir, name)))
    writeFileSync(join(workspaceDir, file), text)
    return { stdout: "done", firstByteMs: 1 }
  },
})

describe("groupProblems (agent 1)", () => {
  const existing = [{ id: "learning-1", title: "Agents return early", cause: "No wait rule." }]

  test("LR1: groups come back with the real problem and learning ids", async () => {
    const seen: { files?: string[] } = {}
    const result = await groupProblems({
      problems: [problem("a"), problem("b"), problem("c")],
      learnings: existing,
      runner: agent(
        "groups.md",
        "## Wait\n- **Joins:** K1\n- **Cause:** No wait rule.\n- **Problems:** P1, P3\n\n## Mocks\n- **Joins:** new\n- **Cause:** Mocks allowed.\n- **Problems:** P2\n",
        seen,
      ),
    })
    expect(seen.files).toEqual([
      "CONTRACT.md",
      "problems.md",
      "known-learnings.md",
      "groups.md",
      "check.mjs",
    ])
    expect(result).toEqual({
      ok: true,
      groups: [
        { cause: "No wait rule.", learningId: "learning-1", problemIds: ["a", "c"] },
        { cause: "Mocks allowed.", learningId: null, problemIds: ["b"] },
      ],
    })
  })

  test("LR2: groups that fail the check fail the grouping, with the reasons", async () => {
    const result = await groupProblems({
      problems: [problem("a"), problem("b")],
      learnings: [],
      runner: agent("groups.md", "## Wait\n- **Joins:** new\n- **Cause:** x\n- **Problems:** P1\n"),
    })
    expect(result).toEqual({ ok: false, errors: ["Not in any group: P2"] })
  })

  test("LR3: the check script the agent runs agrees with the code", async () => {
    let output = ""
    await groupProblems({
      problems: [problem("a"), problem("b")],
      learnings: [],
      runner: {
        run: async ({ workspaceDir }) => {
          writeFileSync(
            join(workspaceDir, "groups.md"),
            "## A\n- **Joins:** new\n- **Cause:** x\n- **Problems:** P1\n",
          )
          try {
            execFileSync("node", ["check.mjs"], { cwd: workspaceDir, encoding: "utf8" })
          } catch (error) {
            output = String((error as { stdout?: string }).stdout)
          }
          return { stdout: "", firstByteMs: 1 }
        },
      },
    })
    expect(output).toContain("Not in any group: P2")
  })
})

const LIMITS = { high: 5, medium: 8 }

describe("writeLearnings (agent 2)", () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })
  const harness = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "harness-test-"))
    dirs.push(dir)
    mkdirSync(join(dir, "skills", "verify"), { recursive: true })
    writeFileSync(
      join(dir, "skills", "verify", "SKILL.md"),
      "Rule: never check against mocked data.\n",
    )
    return dir
  }
  const existing: LearningInput = {
    id: "learning-1",
    title: "Agents return early",
    cause: "No wait rule.",
    problem: "Helpers stop early.",
    priority: "low",
    priorityReason: "One session.",
    fixType: "skill",
    fix: "Add a wait rule.",
    impact: null,
    impactReason: null,
    howItHelps: null,
    fixSummary: null,
  }
  const written = `## G1
- **Verdict:** learning
- **Title:** Helpers report while their run is still going
- **Problem:** The orchestrator has to chase them.
- **Priority:** high — 3 sessions
- **Impact:** time_only — lost a few minutes
- **Fix type:** skill
- **Fix:** In skills/implement/SKILL.md, add a wait rule.
- **How it helps:** Saves a few minutes a run.
- **In plain words:** Make the agent wait before it reports.

## G2
- **Verdict:** drop
- **Why:** One session, medium and slow, a one-off typo.
`

  test("LR4: the harness is copied in, and each group gets its answer in order", async () => {
    const seen: { files?: string[] } = {}
    const result = await writeLearnings({
      groups: [
        { cause: "No wait rule.", existing, problems: [problem("a")] },
        { cause: "Mocks allowed.", existing: null, problems: [problem("b")] },
      ],
      harnessDir: harness(),
      priorityLimits: LIMITS,
      runner: agent("learnings.md", written, seen),
    })
    expect(seen.files).toEqual(["CONTRACT.md", "groups.md", "check.mjs", "harness"])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.answers[0]).toMatchObject({ verdict: "learning", priority: "high" })
    expect(result.answers[1]).toEqual({
      verdict: "drop",
      reason: "One session, medium and slow, a one-off typo.",
    })
  })

  test("LR5: too many new high learnings go back to the agent once, and a second miss fails", async () => {
    const prompts: string[] = []
    const high = (id: string) =>
      `## ${id}\n- **Verdict:** learning\n- **Title:** t\n- **Problem:** p\n- **Priority:** high — why\n- **Impact:** time_only — lost a few minutes\n- **Fix type:** skill\n- **Fix:** f\n- **How it helps:** Saves a few minutes a run.\n- **In plain words:** Make the agent wait before it reports.\n`
    const result = await writeLearnings({
      groups: [
        { cause: "a", existing: null, problems: [problem("a")] },
        { cause: "b", existing: null, problems: [problem("b")] },
      ],
      harnessDir: harness(),
      priorityLimits: { high: 1, medium: 8 },
      runner: {
        run: async ({ workspaceDir, prompt }) => {
          prompts.push(prompt)
          writeFileSync(join(workspaceDir, "learnings.md"), [high("G1"), high("G2")].join("\n"))
          return { stdout: "", firstByteMs: 1 }
        },
      },
    })
    expect(prompts).toHaveLength(2)
    expect(prompts[1]).toContain("2 new learnings are high")
    expect(result.ok).toBe(false)
  })

  test("LR6: the agent's check script enforces the same limit", async () => {
    let output = ""
    await writeLearnings({
      groups: [{ cause: "a", existing: null, problems: [problem("a")] }],
      harnessDir: harness(),
      priorityLimits: { high: 0, medium: 8 },
      runner: {
        run: async ({ workspaceDir }) => {
          writeFileSync(
            join(workspaceDir, "learnings.md"),
            "## G1\n- **Verdict:** learning\n- **Title:** t\n- **Problem:** p\n- **Priority:** high — why\n- **Impact:** time_only — lost a few minutes\n- **Fix type:** skill\n- **Fix:** f\n- **How it helps:** Saves a few minutes a run.\n- **In plain words:** Make the agent wait before it reports.\n",
          )
          try {
            execFileSync("node", ["check.mjs"], { cwd: workspaceDir, encoding: "utf8" })
          } catch (error) {
            output = String((error as { stdout?: string }).stdout)
          }
          return { stdout: "", firstByteMs: 1 }
        },
      },
    })
    expect(output).toContain("1 new learnings are high (G1), and this batch may make at most 0")
  })
})

describe("one retry, and tracing", () => {
  test("LR7: a grouping that fails the check is sent back once with what is wrong, and the fix is kept", async () => {
    const prompts: string[] = []
    const result = await groupProblems({
      problems: [problem("a"), problem("b")],
      learnings: [],
      runner: {
        run: async ({ workspaceDir, prompt }) => {
          prompts.push(prompt)
          const ids = prompts.length === 1 ? "P1" : "P1, P2"
          writeFileSync(
            join(workspaceDir, "groups.md"),
            `## A\n- **Joins:** new\n- **Cause:** x\n- **Problems:** ${ids}\n`,
          )
          return { stdout: "", firstByteMs: 1 }
        },
      },
    })
    expect(prompts).toHaveLength(2)
    expect(prompts[1]).toContain("Not in any group: P2")
    expect(result).toMatchObject({ ok: true, groups: [{ problemIds: ["a", "b"] }] })
  })

  test("LR8: every step is traced as data: the ids, each try's groups, and what the check found", async () => {
    const steps: Array<[string, Record<string, unknown>]> = []
    let tries = 0
    await groupProblems({
      problems: [problem("a"), problem("b")],
      learnings: [{ id: "learning-1", title: "Agents return early", cause: "No wait rule." }],
      trace: (step, fields) => steps.push([step, { ...fields }]),
      runner: {
        run: async ({ workspaceDir }) => {
          tries += 1
          const ids = tries === 1 ? "P1" : "P1, P2"
          writeFileSync(
            join(workspaceDir, "groups.md"),
            `## A\n- **Joins:** new\n- **Cause:** x\n- **Problems:** ${ids}\n`,
          )
          return { stdout: "", firstByteMs: 1 }
        },
      },
    })
    expect(steps.map(([step, fields]) => [step, fields.attempt])).toEqual([
      ["agent1.ids", undefined],
      ["agent1.answer", 1],
      ["agent1.answer", 2],
    ])
    expect(steps[0]?.[1].problems).toEqual([
      { id: "P1", problemId: "a", sessionId: "session-a", title: "Problem a" },
      { id: "P2", problemId: "b", sessionId: "session-b", title: "Problem b" },
    ])
    expect(steps[0]?.[1].learnings).toEqual([
      { id: "K1", learningId: "learning-1", title: "Agents return early" },
    ])
    expect(steps[1]?.[1].errors).toEqual(["Not in any group: P2"])
    expect(steps[2]?.[1]).toMatchObject({ errors: [], groups: [{ problems: ["P1", "P2"] }] })
  })
})

describe("snapshotHarness", () => {
  test("LR9: copies the committed files at HEAD and names the commit, leaving uncommitted edits out", async () => {
    const repo = mkdtempSync(join(tmpdir(), "harness-repo-"))
    const out = mkdtempSync(join(tmpdir(), "harness-out-"))
    try {
      const git = (...args: string[]) =>
        execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" })
      git("init", "-q")
      writeFileSync(join(repo, "SKILL.md"), "committed\n")
      git("add", ".")
      git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "first")
      writeFileSync(join(repo, "SKILL.md"), "edited, not committed\n")
      const { ref } = await snapshotHarness(repo, join(out, "harness"))
      expect(ref).toMatch(/^[0-9a-f]{40}$/)
      expect(readFileSync(join(out, "harness", "SKILL.md"), "utf8")).toBe("committed\n")
    } finally {
      rmSync(repo, { recursive: true, force: true })
      rmSync(out, { recursive: true, force: true })
    }
  })
})

describe("cloneHarness", () => {
  test("LR10: clones the default branch, names the commit, and leaves no .git behind", async () => {
    const repo = mkdtempSync(join(tmpdir(), "harness-remote-"))
    const out = mkdtempSync(join(tmpdir(), "harness-clone-"))
    try {
      const git = (...args: string[]) =>
        execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" })
      git("init", "-q")
      writeFileSync(join(repo, "SKILL.md"), "from the remote\n")
      git("add", ".")
      git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "first")
      const head = git("rev-parse", "HEAD").trim()

      const { ref } = await cloneHarness(`file://${repo}`, join(out, "harness"))

      expect(ref).toBe(head)
      expect(readFileSync(join(out, "harness", "SKILL.md"), "utf8")).toBe("from the remote\n")
      // The agent reads the harness, not its history.
      expect(existsSync(join(out, "harness", ".git"))).toBe(false)
    } finally {
      rmSync(repo, { recursive: true, force: true })
      rmSync(out, { recursive: true, force: true })
    }
  })
})
