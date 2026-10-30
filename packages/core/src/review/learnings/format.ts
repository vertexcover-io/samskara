import { PROBLEM_CLASSES, PROBLEM_SEVERITIES } from "../problems/reviewMd.js"
import {
  LEARNING_IMPACTS,
  LEARNING_PRIORITIES,
  type LearningInput,
  type ProblemInput,
  type WrittenLearning,
} from "./types.js"

/** Longest cause agent 1 may write; a cause is a sentence or two, not a report. */
export const CAUSE_MAX = 400

/** The limits on what agent 2 writes, the same idea as review.md's. Impact and how it helps are one sentence each. */
export const WRITTEN_LIMITS = {
  title: 120,
  problem: 600,
  priorityReason: 300,
  fix: 1200,
  impactReason: 300,
  howItHelps: 300,
} as const

/**
 * The readers of both agents' files, as plain JavaScript source. The check scripts the agents
 * run embed this text, and code reads the files back with the same functions (`PARSERS`), so
 * what an agent is told passes is exactly what code accepts. No imports: the workspace has
 * node and nothing else.
 */
const PARSERS_JS = String.raw`
/**
 * "## heading" sections, each with its "- **Name:** value" fields; a field may wrap. The same
 * job as fieldsOf in problems/reviewMd.ts, written again here because the check scripts
 * have no imports; change both together.
 */
const sections = (text) => {
  const out = []
  let current = null
  let field = null
  for (const line of String(text).split("\n")) {
    const heading = /^##\s+(.+?)\s*$/.exec(line)
    if (heading) {
      current = { heading: heading[1], fields: {} }
      out.push(current)
      field = null
      continue
    }
    if (current === null) continue
    const named = /^\s*-\s+\*\*([^*]+?):?\*\*:?\s*(.*)$/.exec(line)
    if (named) {
      field = named[1].trim().toLowerCase()
      current.fields[field] = named[2].trim()
      continue
    }
    if (field !== null && line.trim() !== "" && !/^#/.test(line))
      current.fields[field] = (current.fields[field] + " " + line.trim()).trim()
    else if (line.trim() === "") field = null
  }
  return out
}

const parseGroupsMd = (text, problemIds, learningIds, causeMax) => {
  const errors = []
  const groups = []
  const seen = new Map()
  const joined = new Map()
  for (const section of sections(text)) {
    const name = section.heading
    const joins = (section.fields.joins ?? "").trim()
    const cause = (section.fields.cause ?? "").trim()
    const problems = (section.fields.problems ?? "").split(/[\s,]+/).filter(Boolean)
    if (joins === "") errors.push('"' + name + '" has no Joins: write "- **Joins:** new" or a learning id like K1')
    else if (joins.toLowerCase() !== "new" && !learningIds.includes(joins))
      errors.push('"' + name + '": ' + joins + " is not a learning id in known-learnings.md")
    else if (joins.toLowerCase() !== "new") {
      if (joined.has(joins)) errors.push(joins + " is joined by more than one group: merge them")
      joined.set(joins, name)
    }
    if (cause === "") errors.push('"' + name + '" has no Cause')
    else if (cause.length > causeMax) errors.push('"' + name + '": Cause is over ' + causeMax + " characters")
    if (problems.length === 0) errors.push('"' + name + '" has no Problems')
    for (const id of problems) {
      if (!problemIds.includes(id)) errors.push('"' + name + '": ' + id + " is not a problem id in problems.md")
      else if (seen.has(id)) errors.push(id + " is in more than one group")
      else seen.set(id, name)
    }
    groups.push({ name, joins: joins.toLowerCase() === "new" ? null : joins, cause, problems })
  }
  const missing = problemIds.filter((id) => !seen.has(id))
  if (missing.length > 0) errors.push("Not in any group: " + missing.join(", "))
  return { groups, errors }
}

/**
 * rules.joined: groups that update an existing learning, which may not be dropped and do not
 * count toward the limits. rules.maxHigh / rules.maxMedium: how many new learnings this batch
 * may make at those priorities.
 */
const parseWrittenMd = (text, groupIds, fixTypes, priorities, impacts, limits, rules) => {
  const errors = []
  const answers = {}
  for (const section of sections(text)) {
    const id = section.heading.split(/[\s:]/)[0]
    if (!groupIds.includes(id)) {
      errors.push(section.heading + " is not a group id in groups.md")
      continue
    }
    if (answers[id] !== undefined) {
      errors.push(id + " is answered more than once")
      continue
    }
    const f = section.fields
    const verdict = (f.verdict ?? "").toLowerCase()
    if (verdict === "drop") {
      if (rules.joined.includes(id)) {
        errors.push(id + ": it updates an existing learning, so it cannot be dropped")
        continue
      }
      const reason = (f.why ?? "").trim()
      if (reason === "") errors.push(id + ": a drop needs - **Why:** and one sentence")
      else if (reason.length > limits.priorityReason)
        errors.push(id + ": Why is over " + limits.priorityReason + " characters")
      else answers[id] = { verdict: "drop", reason }
      continue
    }
    if (verdict !== "learning") {
      errors.push(id + ": Verdict must be learning or drop")
      continue
    }
    const before = errors.length
    const required = (name, limit) => {
      const value = (f[name.toLowerCase()] ?? "").trim()
      if (value === "") errors.push(id + ": missing " + name)
      else if (limit !== undefined && value.length > limit)
        errors.push(id + ": " + name + " is over " + limit + " characters")
      return value
    }
    const title = required("Title", limits.title)
    const problem = required("Problem", limits.problem)
    const fix = required("Fix", limits.fix)
    const priorityRaw = required("Priority")
    const [word, ...reason] = priorityRaw.split(/\s+[—–-]\s+/)
    const priority = (word ?? "").trim().toLowerCase()
    const priorityReason = reason.join(" — ").trim()
    if (priorityRaw !== "" && !priorities.includes(priority))
      errors.push(
        id + ": Priority must be " + priorities.slice(0, -1).join(", ") + " or " + priorities.at(-1) +
          ", then — and one sentence why",
      )
    else if (priorityRaw !== "" && priorityReason === "")
      errors.push(id + ": Priority needs a reason after the word")
    else if (priorityReason.length > limits.priorityReason)
      errors.push(id + ": the priority reason is over " + limits.priorityReason + " characters")
    const fixType = required("Fix type")
    if (fixType !== "" && !fixTypes.includes(fixType))
      errors.push(id + ": Fix type must be one of " + fixTypes.join(", "))
    const impactRaw = required("Impact")
    const [impactWord, ...impactRest] = impactRaw.split(/\s+[—–-]\s+/)
    const impact = (impactWord ?? "").trim().toLowerCase()
    const impactReason = impactRest.join(" — ").trim()
    if (impactRaw !== "" && !impacts.includes(impact))
      errors.push(
        id + ": Impact must be " + impacts.slice(0, -1).join(", ") + " or " + impacts.at(-1) +
          ", then — and one sentence",
      )
    else if (impactRaw !== "" && impactReason === "")
      errors.push(id + ": Impact needs one sentence after the word")
    else if (impactReason.length > limits.impactReason)
      errors.push(id + ": the impact sentence is over " + limits.impactReason + " characters")
    const howItHelps = required("How it helps", limits.howItHelps)
    if (errors.length === before)
      answers[id] = {
        verdict: "learning", title, problem, priority, priorityReason, fixType, fix,
        impact, impactReason, howItHelps,
      }
  }
  const missing = groupIds.filter((id) => answers[id] === undefined && !errors.some((e) => e.startsWith(id + ":")))
  if (missing.length > 0) errors.push("Not answered: " + missing.join(", "))
  for (const [word, max] of [["high", rules.maxHigh], ["medium", rules.maxMedium]]) {
    const ids = Object.entries(answers)
      .filter(([id, a]) => a.verdict === "learning" && a.priority === word && !rules.joined.includes(id))
      .map(([id]) => id)
    if (ids.length > max)
      errors.push(
        ids.length + " new learnings are " + word + " (" + ids.join(", ") + "), and this batch may make at most " +
          max + ": keep the most important " + max + " " + word + " and move the rest down a level",
      )
  }
  return { answers, errors }
}
`

/** What agent 2 may do in one batch: which groups update a learning, and the priority limits. */
export type WrittenRules = {
  readonly joined: ReadonlyArray<string>
  readonly maxHigh: number
  readonly maxMedium: number
}

type Parsers = {
  parseGroupsMd: (
    text: string,
    problemIds: ReadonlyArray<string>,
    learningIds: ReadonlyArray<string>,
    causeMax: number,
  ) => {
    groups: Array<{ name: string; joins: string | null; cause: string; problems: string[] }>
    errors: string[]
  }
  parseWrittenMd: (
    text: string,
    groupIds: ReadonlyArray<string>,
    fixTypes: ReadonlyArray<string>,
    priorities: ReadonlyArray<string>,
    impacts: ReadonlyArray<string>,
    limits: typeof WRITTEN_LIMITS,
    rules: WrittenRules,
  ) => { answers: Record<string, WrittenLearning>; errors: string[] }
}

// One source for both: the check scripts embed PARSERS_JS, and this is the same text, run.
const PARSERS = new Function(`${PARSERS_JS}\nreturn { parseGroupsMd, parseWrittenMd }`)() as Parsers

/** Agent 1's groups.md, checked against the ids it was given. */
export const parseGroupsMd = (
  text: string,
  problemIds: ReadonlyArray<string>,
  learningIds: ReadonlyArray<string>,
) => PARSERS.parseGroupsMd(text, problemIds, learningIds, CAUSE_MAX)

/** Agent 2's learnings.md, one answer per group id. */
export const parseWrittenMd = (
  text: string,
  groupIds: ReadonlyArray<string>,
  fixTypes: ReadonlyArray<string>,
  rules: WrittenRules,
) =>
  PARSERS.parseWrittenMd(
    text,
    groupIds,
    fixTypes,
    LEARNING_PRIORITIES,
    LEARNING_IMPACTS,
    WRITTEN_LIMITS,
    rules,
  )

/** Agent 1's check: run with node in its workspace, it prints what is wrong with groups.md. */
export const groupsCheckScript = (
  problemIds: ReadonlyArray<string>,
  learningIds: ReadonlyArray<string>,
): string => `import { readFileSync } from "node:fs"
${PARSERS_JS}
const { groups, errors } = parseGroupsMd(
  readFileSync("groups.md", "utf8"),
  ${JSON.stringify(problemIds)},
  ${JSON.stringify(learningIds)},
  ${CAUSE_MAX},
)
if (errors.length > 0) {
  console.log(errors.join("\\n"))
  process.exit(1)
}
console.log("All " + ${problemIds.length} + " problems are in " + groups.length + " groups.")
`

/** Agent 2's check: every group answered, every field in shape, and the batch's limits kept. */
export const writtenCheckScript = (
  groupIds: ReadonlyArray<string>,
  fixTypes: ReadonlyArray<string>,
  rules: WrittenRules,
): string => `import { readFileSync } from "node:fs"
${PARSERS_JS}
const { errors } = parseWrittenMd(
  readFileSync("learnings.md", "utf8"),
  ${JSON.stringify(groupIds)},
  ${JSON.stringify(fixTypes)},
  ${JSON.stringify(LEARNING_PRIORITIES)},
  ${JSON.stringify(LEARNING_IMPACTS)},
  ${JSON.stringify(WRITTEN_LIMITS)},
  ${JSON.stringify(rules)},
)
if (errors.length > 0) {
  console.log(errors.join("\\n"))
  process.exit(1)
}
console.log("All " + ${groupIds.length} + " groups are answered.")
`

const quotesOf = (problem: ProblemInput): string =>
  problem.evidence.map((evidence) => `"${evidence.quote}"`).join("; ")

/**
 * problems.md for agent 1: the new problems, each under a short id. Evidence goes in as its
 * quotes only — the message ids mean nothing outside their session.
 */
export const problemsMd = (problems: ReadonlyArray<ProblemInput>): string =>
  [
    "# New problems",
    "",
    ...problems.flatMap((problem, index) => [
      `## P${index + 1}`,
      "",
      `- **Title:** ${problem.title}`,
      `- **Class:** ${problem.class}`,
      `- **Severity:** ${problem.severity} — ${problem.severityReason}`,
      `- **Fix type:** ${problem.fixType}`,
      `- **Description:** ${problem.description}`,
      `- **Learning:** ${problem.learning}`,
      `- **Evidence:** ${quotesOf(problem)}`,
      "",
    ]),
  ].join("\n")

/** known-learnings.md for agent 1: the learnings found so far, each under a short id. */
export const knownLearningsMd = (
  learnings: ReadonlyArray<Pick<LearningInput, "id" | "title" | "cause">>,
): string =>
  learnings.length === 0
    ? "# Learnings found so far\n\nNone yet: every group is new.\n"
    : [
        "# Learnings found so far",
        "",
        ...learnings.flatMap((learning, index) => [
          `## K${index + 1}: ${learning.title}`,
          "",
          `Cause: ${learning.cause}`,
          "",
        ]),
      ].join("\n")

const indent = (text: string): string =>
  text
    .split("\n")
    .map((line) => (line === "" ? line : `    ${line}`))
    .join("\n")

/**
 * How many times it happened: each evidence line is one time. A review writes one problem per
 * cause, so a mistake repeated in one session is one problem with several evidence lines.
 */
const timesHappened = (problems: ReadonlyArray<ProblemInput>): number =>
  problems.reduce((sum, problem) => sum + problem.evidence.length, 0)

/** A mistake made this many times in one session is not a one-off: the agent did not learn. */
export const ONE_OFF_BELOW = 3

/**
 * Why a new group is a one-off, or null when it is not: all its problems from one session, none
 * of them high severity, and it happened fewer than `ONE_OFF_BELOW` times. Code drops these
 * before agent 2 reads them, so the rule holds whatever the agent decides.
 */
export const oneOffReason = (problems: ReadonlyArray<ProblemInput>): string | null => {
  const sessions = new Set(problems.map((problem) => problem.sessionId)).size
  const times = timesHappened(problems)
  if (sessions !== 1 || problems.some((problem) => problem.severity === "high")) return null
  if (times >= ONE_OFF_BELOW) return null
  return `One session, no high-severity problem, and it happened ${times} times.`
}

const count = <T extends string>(values: ReadonlyArray<string>, names: ReadonlyArray<T>): string =>
  names.map((name) => `${values.filter((value) => value === name).length} ${name}`).join(", ")

/** One group as agent 2 sees it. */
export type WriterGroup = {
  readonly id: string
  readonly cause: string
  /** The learning it joins, when it joins one. */
  readonly existing: LearningInput | null
  /** Every problem behind it: the new ones and, for an existing learning, the ones already linked. */
  readonly problems: ReadonlyArray<ProblemInput>
}

/**
 * A learning that keeps coming up collects problems run after run; listing them all would
 * grow agent 2's input without end. The newest this many are listed, and every one is counted.
 */
const MAX_LISTED_PROBLEMS = 30

/**
 * groups.md for agent 2: per group, its cause, the learning it updates if any, the numbers
 * priority is set from (over every problem), and the newest problems behind it — each new
 * one with its evidence and the session around it.
 */
export const groupsForWriter = (
  groups: ReadonlyArray<WriterGroup>,
  /** How many new learnings this batch may still make at high and at medium priority. */
  limits: { readonly high: number; readonly medium: number },
): string =>
  [
    "# Groups",
    "",
    `This batch may make at most ${limits.high} new high-priority and ${limits.medium} new medium-priority learnings; low has no limit. Learnings you update do not count.`,
    "",
    ...groups.flatMap((group) => {
      const sessions = new Set(group.problems.map((problem) => problem.sessionId)).size
      return [
        `## ${group.id}`,
        "",
        `- **Cause:** ${group.cause}`,
        group.existing === null
          ? "- **Existing learning:** none, this is new"
          : [
              "- **Existing learning:** update this one",
              `  - Title: ${group.existing.title}`,
              `  - Problem: ${group.existing.problem}`,
              `  - Priority: ${group.existing.priority} — ${group.existing.priorityReason}`,
              ...(group.existing.impact === null
                ? []
                : [`  - Impact: ${group.existing.impact} — ${group.existing.impactReason ?? ""}`]),
              ...(group.existing.howItHelps === null
                ? []
                : [`  - How it helps: ${group.existing.howItHelps}`]),
              `  - Fix type: ${group.existing.fixType}`,
              `  - Fix: ${group.existing.fix}`,
            ].join("\n"),
        `- **Numbers:** ${group.problems.length} problems in ${sessions} sessions, happened ${timesHappened(group.problems)} times; severity: ${count(
          group.problems.map((problem) => problem.severity),
          PROBLEM_SEVERITIES,
        )}; class: ${count(
          group.problems.map((problem) => problem.class),
          PROBLEM_CLASSES,
        )}`,
        "",
        "Problems:",
        "",
        ...(group.problems.length > MAX_LISTED_PROBLEMS
          ? [
              `- (${group.problems.length - MAX_LISTED_PROBLEMS} earlier problems not listed; the Numbers line counts them)`,
            ]
          : []),
        ...group.problems
          .slice(-MAX_LISTED_PROBLEMS)
          .flatMap((problem) => [
            `- [${problem.class}, ${problem.severity}] ${problem.title} — ${problem.description} Learning: ${problem.learning}`,
            ...(problem.excerpt === undefined
              ? []
              : ["", "  Evidence, with the session around it:", "", indent(problem.excerpt), ""]),
          ]),
        "",
      ]
    }),
  ].join("\n")
