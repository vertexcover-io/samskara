import { execFile } from "node:child_process"
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { FIX_TYPES } from "../problems/reviewMd.js"
import { readOr, withWorkspace } from "../problems/workspace.js"
import type { HarnessRunInput, HarnessRunner } from "../runner.js"
import {
  buildGrouperPrompt,
  buildWriterPrompt,
  GROUPER_CONTRACT,
  WRITER_CONTRACT,
} from "./contract.js"
import {
  groupsCheckScript,
  groupsForWriter,
  knownLearningsMd,
  parseGroupsMd,
  parseWrittenMd,
  problemsMd,
  type WriterGroup,
  writtenCheckScript,
} from "./format.js"
import type { LearningInput, ProblemGroup, ProblemInput, WrittenLearning } from "./types.js"

const execFileAsync = promisify(execFile)

type RunChoice = Pick<HarnessRunInput, "harness" | "model">

export type LearningStepFailed = { readonly ok: false; readonly errors: ReadonlyArray<string> }

/**
 * Called with each step of an agent's work as it happens — the ids it was given, what it wrote
 * and how code read it, what the check found — so a run can keep a full record of how it
 * decided. `step` names the event (`agent1.answer`); `fields` are its data, ready for JSON.
 */
export type LearningTrace = (step: string, fields: Readonly<Record<string, unknown>>) => void

/** Group N's id in the writer's files and in the run's log. */
export const writerGroupId = (index: number): string => `G${index + 1}`

/**
 * Runs an agent on its workspace, reads back the file it writes, and gives it one more try
 * when that file fails the check: the same workspace, and what was wrong. Every read is traced.
 * One retry, because an answer that fails twice usually fails the same way again.
 */
const runChecked = async <T extends { readonly errors: ReadonlyArray<string> }>(input: {
  readonly workspaceDir: string
  readonly runner: HarnessRunner
  readonly run: RunChoice | undefined
  readonly prompt: string
  /** The file the agent writes. */
  readonly file: string
  readonly parse: (text: string) => T
  /** Traces one read: its attempt number, what was parsed, and the raw file. */
  readonly trace: (attempt: number, parsed: T, text: string) => void
}): Promise<T> => {
  const read = async (attempt: number): Promise<T> => {
    const text = await readOr(join(input.workspaceDir, input.file))
    const parsed = input.parse(text)
    input.trace(attempt, parsed, text)
    return parsed
  }
  await input.runner.run({ ...input.run, prompt: input.prompt, workspaceDir: input.workspaceDir })
  const first = await read(1)
  if (first.errors.length === 0) return first
  await input.runner.run({
    ...input.run,
    prompt: retryPrompt(input.file, first.errors),
    workspaceDir: input.workspaceDir,
  })
  return read(2)
}

/** The second try's prompt: what was wrong with the first answer. */
const retryPrompt = (file: string, errors: ReadonlyArray<string>): string =>
  [
    `Your \`${file}\` does not pass yet. \`CONTRACT.md\` still says how it must look. What is wrong:`,
    "",
    ...errors.slice(0, 50).map((error) => `- ${error}`),
    "",
    `Fix \`${file}\` and run \`node check.mjs\` until it passes. Your final reply is one short line.`,
  ].join("\n")

/**
 * Agent 1, the grouper: the new problems put into groups by cause, each group joining a
 * learning already found or starting a new one. Every problem lands in exactly one group, or
 * the grouping fails.
 */
export const groupProblems = async (input: {
  readonly problems: ReadonlyArray<ProblemInput>
  readonly learnings: ReadonlyArray<Pick<LearningInput, "id" | "title" | "cause">>
  readonly runner: HarnessRunner
  readonly run?: RunChoice
  readonly trace?: LearningTrace
}): Promise<
  { readonly ok: true; readonly groups: ReadonlyArray<ProblemGroup> } | LearningStepFailed
> => {
  const trace = input.trace ?? (() => {})
  // Short ids in the files, real ids back out: an agent copies P3 more reliably than a uuid.
  const problemIds = input.problems.map((_, index) => `P${index + 1}`)
  const learningIds = input.learnings.map((_, index) => `K${index + 1}`)
  trace("agent1.ids", {
    problems: input.problems.map((problem, index) => ({
      id: problemIds[index],
      problemId: problem.id,
      sessionId: problem.sessionId,
      title: problem.title,
    })),
    learnings: input.learnings.map((learning, index) => ({
      id: learningIds[index],
      learningId: learning.id,
      title: learning.title,
    })),
  })
  const parsed = await withWorkspace(
    "samskara-learnings-group-",
    {
      "CONTRACT.md": GROUPER_CONTRACT,
      "problems.md": problemsMd(input.problems),
      "known-learnings.md": knownLearningsMd(input.learnings),
      "groups.md": "# Groups\n",
      "check.mjs": groupsCheckScript(problemIds, learningIds),
    },
    (workspaceDir) =>
      runChecked({
        workspaceDir,
        runner: input.runner,
        run: input.run,
        prompt: buildGrouperPrompt(),
        file: "groups.md",
        parse: (text) => parseGroupsMd(text, problemIds, learningIds),
        trace: (attempt, { groups, errors }, file) =>
          trace("agent1.answer", { attempt, groups, errors, file }),
      }),
  )
  if (parsed.errors.length > 0) return { ok: false, errors: parsed.errors }
  const problemById = new Map(problemIds.map((short, index) => [short, input.problems[index]?.id]))
  const learningById = new Map(
    learningIds.map((short, index) => [short, input.learnings[index]?.id]),
  )
  return {
    ok: true,
    groups: parsed.groups.map((group) => ({
      cause: group.cause,
      learningId: group.joins === null ? null : (learningById.get(group.joins) ?? null),
      problemIds: group.problems.map((short) => problemById.get(short) as string),
    })),
  }
}

/**
 * Agent 2, the writer: each group checked against the harness code and its evidence, then
 * written up as a learning or dropped. A group that updates an existing learning is never
 * dropped, and new learnings stay within the batch's high and medium limits. `harnessDir` is
 * copied into the workspace for the agent to read. Answers come back in group order.
 */
export const writeLearnings = async (input: {
  readonly groups: ReadonlyArray<Omit<WriterGroup, "id">>
  readonly harnessDir: string
  /** New high and medium learnings this batch may still make; updated ones do not count. */
  readonly priorityLimits: { readonly high: number; readonly medium: number }
  readonly runner: HarnessRunner
  readonly run?: RunChoice
  readonly trace?: LearningTrace
}): Promise<
  { readonly ok: true; readonly answers: ReadonlyArray<WrittenLearning> } | LearningStepFailed
> => {
  const trace = input.trace ?? (() => {})
  const groups = input.groups.map((group, index) => ({ ...group, id: writerGroupId(index) }))
  const groupIds = groups.map((group) => group.id)
  const rules = {
    joined: groups.flatMap((group) => (group.existing === null ? [] : [group.id])),
    maxHigh: input.priorityLimits.high,
    maxMedium: input.priorityLimits.medium,
  }
  const result = await withWorkspace(
    "samskara-learnings-write-",
    {
      "CONTRACT.md": WRITER_CONTRACT,
      "groups.md": groupsForWriter(groups, input.priorityLimits),
      "check.mjs": writtenCheckScript(groupIds, FIX_TYPES, rules),
    },
    async (workspaceDir) => {
      await cp(input.harnessDir, join(workspaceDir, "harness"), { recursive: true })
      return runChecked({
        workspaceDir,
        runner: input.runner,
        run: input.run,
        prompt: buildWriterPrompt(),
        file: "learnings.md",
        parse: (text) => parseWrittenMd(text, groupIds, FIX_TYPES, rules),
        trace: (attempt, { answers, errors }, file) =>
          trace("agent2.answer", { attempt, answers, errors, file }),
      })
    },
  )
  if (result.errors.length > 0) return { ok: false, errors: result.errors }
  return { ok: true, answers: groupIds.map((id) => result.answers[id] as WrittenLearning) }
}

/**
 * The harness as committed at HEAD, written to `dest`, and the commit it came from. Committed
 * files only: what a learning is checked against should be what everyone running the
 * harness has, not someone's uncommitted edit.
 */
export const snapshotHarness = async (
  repo: string,
  dest: string,
): Promise<{ readonly ref: string }> => {
  const { stdout } = await execFileAsync("git", ["-C", repo, "rev-parse", "HEAD"])
  const ref = stdout.trim()
  await mkdir(dest, { recursive: true })
  const scratch = await mkdtemp(join(tmpdir(), "samskara-harness-"))
  try {
    const archive = join(scratch, "harness.tar")
    await execFileAsync("git", ["-C", repo, "archive", "--format=tar", "-o", archive, ref])
    await execFileAsync("tar", ["-x", "-f", archive, "-C", dest])
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
  return { ref }
}

/** A scratch copy of the harness for one run: snapshotted, used, removed. */
export const withHarnessSnapshot = <T>(
  repo: string,
  work: (snapshot: { readonly dir: string; readonly ref: string }) => Promise<T>,
): Promise<T> =>
  withWorkspace("samskara-harness-snapshot-", {}, async (dir) =>
    work({ dir, ref: (await snapshotHarness(repo, dir)).ref }),
  )
