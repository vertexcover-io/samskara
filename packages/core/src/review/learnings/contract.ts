import { WRITING_RULES } from "../writingRules.js"
import { CAUSE_MAX, FIX_PARTS_MAX, ONE_OFF_BELOW, WRITTEN_LIMITS } from "./format.js"
import { LEARNING_IMPACTS } from "./types.js"

/** Agent 1's instructions: put the new problems into groups by the agent's habit. */
export const GROUPER_CONTRACT = `# Group problems by habit

You get problems found in reviews of recorded AI agent sessions, and the learnings found so
far. Put problems that are the same habit into one group.

## Your working directory

- \`problems.md\` — the new problems, each with an id (\`P1\`, \`P2\`, …): its title, class
  (who caught it), severity, where the fix goes, what happened, the learning the reviewer
  wrote, and quotes from the session.
- \`known-learnings.md\` — the learnings found so far, each with an id (\`K1\`, …), its title and its
  cause.
- \`groups.md\` — your answer, which you write.
- \`check.mjs\` — run \`node check.mjs\`. You are done when it says every problem is in a group.

## What a habit is

A habit is the thing the agent does wrong, said so that it covers every time it happens. "The
agent does not check before it speaks or acts" is a habit; "the agent said the tests pass
without running them" is one time it happened.

Two problems belong in one group when they are the same habit, even when it shows up at
different moments: before explaining how something works, before saying something is done,
before running something that deletes or publishes. Group by what the agent does wrong, not by
how a fix for it would be worded. One habit can need a different change at each moment; the
next step writes those changes as parts of one fix, up to ${FIX_PARTS_MAX}.

- Join: "tells the user how things work without checking", "says something is done before
  seeing it work" and "runs commands that delete or publish without checking or asking" are
  one habit: the agent does not check before it speaks or acts.
- Keep apart: "does not check before it speaks" and "writes text too dense to read" are two
  habits, even when both show up in the same reply. One is about checking, the other about
  how it writes.
- The same thing seen, for different habits: different groups.
- A habit is still specific: "the agent makes mistakes" is not one. Name what it skips or
  does wrong, so one learning can tell it what to do instead. A habit seen at more than
  ${FIX_PARTS_MAX} different moments is probably two habits.
- Work the habit out from the title, description and learning. When a problem's habit is not
  clear, give it a group of its own. A group of one is fine.

## Joining a learning

When a group's habit is the habit of a learning in \`known-learnings.md\`, write that learning's
id under Joins, even when that learning was written for one moment and this group shows the
habit at another. Only one group may join a given learning. Otherwise write \`new\`.

## groups.md

One section per group:

\`\`\`markdown
## Does not check before it speaks or acts

- **Joins:** new
- **Cause:** The agent tells the user how something works, says work is done, or runs
  something risky, without first checking: it reads no code, runs nothing, asks no one.
- **Problems:** P1, P4, P9
\`\`\`

- The heading is a short name for the habit.
- Cause: the habit, at most ${CAUSE_MAX} characters. It must make sense with every project name removed.
- Every problem is in exactly one group.

Your final reply is one short line, for example "groups.md ready: 12 groups".
`

export const buildGrouperPrompt = (): string =>
  [
    "You are grouping problems from AI agent session reviews by the agent's habit: the thing it does wrong.",
    "",
    "Read `CONTRACT.md` first: it says how to group and exactly how to write `groups.md`.",
    "Then read `problems.md` and `known-learnings.md`, write `groups.md`, and run `node check.mjs` until it passes.",
    "The file is the deliverable. Your final reply is one short line.",
  ].join("\n")

/** Agent 2's instructions: check each group against the harness and its evidence, drop or write it. */
export const WRITER_CONTRACT = `# Turn groups of problems into learnings

Each group in \`groups.md\` is a set of problems, from reviews of recorded AI agent sessions,
that share one habit: one thing the agent does wrong, which may show up at different moments.
Write one learning per habit. \`harness/\` is the code of the agent harness those sessions ran: its
skills, agents, hooks, commands and docs. For each group, decide whether it is worth a
learning, and if it is, write what should change.

## Your working directory

- \`groups.md\` — the groups, each with an id (\`G1\`, \`G2\`, …): its cause, the learning it
  updates if any, its numbers, and the problems behind it. Each new problem also has its
  evidence: the message ids, the quote, why it is a problem, and the session records around
  it. The top of the file says how many new high and medium learnings this batch may make.
- \`harness/\` — the harness code. Search it with grep; do not change it.
- \`learnings.md\` — your answer, which you write.
- \`check.mjs\` — run \`node check.mjs\`. You are done when it says every group is answered.

## A group that updates an existing learning

Its section says "Existing learning: update this one". The problems came back, so it is never
dropped. The existing fix did not stop them:

1. Read its current fix, and check it against all its problems, the old and the new, and
   against \`harness/\` as it is now. If the fix is already in the harness, it is not working.
2. Write one fix that would stop all of them, not only the new ones. When the new problems
   show the habit at a moment the current fix does not cover, add a part for that moment
   (see "Fix in parts" below), and keep the parts that still hold.
3. Set the priority again from all its problems. Keep the title unless it is wrong, over
   ${WRITTEN_LIMITS.title} characters, or uses a word the list lines may not hold (see
   learnings.md below); then write a new one.

## A new group

One-offs are already gone: code dropped every new group whose problems all come from one
session, none of them high severity, that happened fewer than ${ONE_OFF_BELOW} times. Each new
group here came up in more than one session, has a high-severity problem, or kept happening.
Take these steps in order.

1. **Does it clearly matter?** Read its evidence and the session records around it, and look
   for its cause in \`harness/\`. Keep it only when they clearly show it matters: it caused a
   wrong result, a person had to step in, it keeps happening, or it will happen whenever that
   part of the system is used. When unsure, drop it: a learning that is not worth fixing costs
   the reader more than a missed one.
2. **Write the learning.** If \`harness/\` already has a rule, doc, hook or code for this
   cause, it did not stop these problems: the fix says what to change about it, not "add a
   rule" again. Say an earlier fix "was never added" or "did not work" only when you found it
   in \`harness/\` or its absence there is news: a learning marked as written earlier in this
   run is minutes old, so leave its history out.

## Priority

Set it from the problems and their evidence:

- how often: how many problems, in how many sessions, and how many times it happened in all —
  the same mistake made again and again in one session counts, since the agent did not learn
  even within that session;
- its impact, below: at the same frequency, wrong_result ranks above person_stepped_in, and
  person_stepped_in above time_only;
- the cost each time, against how simple the fix is: a one-line rule that stops a costly
  problem ranks above a large change for the same pain.

- high: it keeps happening or will, and each time costs a wrong result, real time, or a
  person stepping in.
- medium: it costs time more than once, but the agent or a check recovers.
- low: small, rare, or caught early.

How often is not the only measure. A problem that happens whenever someone works on one part
of the system, and costs a lot each time, ranks above a frequent one that costs seconds.

## Impact

What happens when the problem happens, the worst its evidence shows. One of:

- wrong_result: without this fix the output can be wrong, or untested work ships.
- person_stepped_in: a person had to notice it and correct the agent.
- time_only: the agent got there, but wasted time or tokens.

Then a dash and one sentence that says what happened, with the numbers.

New learnings in this batch may be at most as many high and medium as the top of
\`groups.md\` says; low has no limit, and learnings you update do not count. Rank the new ones
before you write them: the most important get high, the next get medium, the rest low. Say why
in one sentence, with the numbers.

## Fix type and fix

Fix type is where the fix goes: skill (a skill or instruction file the agent follows), code (a
code fix or a breadcrumb in the code), project_guidelines (the standing notes every agent
reads, such as AGENTS.md or CLAUDE.md), knowledge_base (knowledge worth writing down once,
looked up when needed), human (the person, not the system, should change).

The fix says where and what. For a fix in \`harness/\`, name the file path (without
\`harness/\`) and say what to add or change; quote the line to change when there is one. For a
fix outside the harness, say who should change what.

## learnings.md

One section per group, headed by its id:

\`\`\`markdown
## G1

- **Verdict:** learning
- **Title:** Helpers report while their tests still run
- **Problem:** Helper agents say they are done while their tests are still running, so the
  main agent has to chase them, often several times in one session.
- **Priority:** high — 9 problems in 6 sessions, and two shipped work nobody had tested
- **Impact:** wrong_result — two sessions shipped code whose tests had not finished running
- **Fix type:** skill
- **Fix:** In skills/implement/SKILL.md, under "Running tests", add: wait for the test command
  to exit and read its result before reporting; never report a run as pending.
- **In plain words:** Make helper agents wait for their tests to finish before they report,
  so a result they hand back is one somebody saw.
- **How it helps:** Saves about 10 minutes a run of chasing helpers, and stops untested work
  from shipping.
- **Step 1:** A helper agent started the test suite in the background.
- **Step 1 quote:** started jest in the background
- **Step 2:** It reported back before the tests finished.
- **Step 2 quote:** waiting on jest, will report results later
- **Step 3:** The main agent took that as done and shipped the change.
- **Step 3 quote:** all helpers reported, opening the pull request
- **Why it's a problem:** The change shipped without anyone seeing its tests pass.
- **What should have happened:** The helper should have waited for the tests to finish and
  reported whether they passed.

## G2

- **Verdict:** drop
- **Why:** Step 1: the evidence shows a typo in one branch name that cost a minute, and
  nothing in the harness makes it likely again.
\`\`\`

Four fields are the lines the Fixes list shows: Title, Problem, the Impact sentence and In
plain words. A reader who never saw the code or this project scans them in seconds, so keep
them short and plain. \`check.mjs\` refuses any of the four that holds a backtick, a file name
or path, the words yok or harness, or the name of a skill, agent, hook or command in
\`harness/\`. Avoid skill and step names even when they are everyday words, such as review or
implement: say what that step does instead.

- Title: the pattern in a few words, at most ${WRITTEN_LIMITS.title} characters. It must make
  sense with every project name removed.
- Problem: what goes wrong, in one or two lines, at most ${WRITTEN_LIMITS.problem}
  characters. It must be true of every session in the group, not one of them: describe the
  pattern, not an example. The example goes in the steps below. For example: "After bringing
  in the latest shared code, the agent blames new test failures on that code without checking
  whether its own change caused them."
- Priority: the word, a dash, then one sentence why, at most ${WRITTEN_LIMITS.priorityReason}
  characters.
- Impact: one of ${LEARNING_IMPACTS.join(", ")}, a dash, then one sentence, at most
  ${WRITTEN_LIMITS.impactReason} characters. The sentence is why it matters, with the numbers.
- Fix: at most ${WRITTEN_LIMITS.fix} characters. For a habit seen at different moments,
  write Part 1 to Part ${FIX_PARTS_MAX} instead (see "Fix in parts" below).
- In plain words: the fix in one line a person who never opened the code would follow, then
  why it works, with no file paths or code, at most ${WRITTEN_LIMITS.fixSummary} characters.
  It is shown first; the Fix field's exact text, or each part, sits under it. For a fix in
  parts it describes the whole habit, not one part.
- How it helps: one sentence on what changes once the fix is in, at most
  ${WRITTEN_LIMITS.howItHelps} characters. Say it in time saved or harm stopped.
- The example: the fix's own page opens on one time it happened. Pick the one time that
  proves the problem on its own, for example where the agent admits the mistake or a result
  shows it. Tell it as Step 1 to Step 3, or Step 4, each one short sentence of at most
  ${WRITTEN_LIMITS.storyStep} characters, in the order it happened, ending where it turned out
  wrong. Give each step a quote: the session's own words, at most ${WRITTEN_LIMITS.storyQuote}
  characters, copied from this group's evidence quotes or the session records shown under
  them in \`groups.md\`. A quote may skip words with \`…\`. \`check.mjs\` refuses a quote it
  cannot find there.
- Why it's a problem: one sentence, at most ${WRITTEN_LIMITS.whyProblem} characters.
- What should have happened: one sentence, at most ${WRITTEN_LIMITS.shouldHave} characters.
- Why (for a drop): one sentence, at most ${WRITTEN_LIMITS.priorityReason} characters: which
  step dropped it, and what in the numbers or the evidence says so.

## Fix in parts

One habit can show up at different moments: before explaining how something works, before
saying something is done, before running something that deletes or publishes. Each moment
may need its own change. Then write the fix in parts, in place of the Fix field:

\`\`\`markdown
- **Part 1:** Before explaining how something works
- **Part 1 change:** In skills/answer/SKILL.md, add: read the code or run it before you
  say how it works, and say which file you read.
- **Part 2:** Before saying something is done
- **Part 2 change:** In skills/implement/SKILL.md, under "Finishing", add: run the change
  and read its output before you report it done.
\`\`\`

- 2 to ${FIX_PARTS_MAX} parts, numbered from Part 1 with no gap. A habit seen at one moment
  keeps one Fix field and no parts; never write both.
- Each heading names the moment in plain words, at most ${WRITTEN_LIMITS.fixPartHeading}
  characters. \`check.mjs\` holds it to the same plain-word check as the four list lines.
- Each change says where and what, the same as a Fix, at most
  ${WRITTEN_LIMITS.fixPartChange} characters; all parts together at most
  ${WRITTEN_LIMITS.fix}.
- Title, Problem, the impact sentence and In plain words describe the whole habit, not one
  moment. The example is still one time it happened, for the whole learning.

${WRITING_RULES}

Your final reply is one short line, for example "learnings.md ready: 8 learnings, 3 dropped".
`

export const buildWriterPrompt = (): string =>
  [
    "You are turning groups of problems from AI agent session reviews into learnings.",
    "",
    "Read `CONTRACT.md` first: it says how to check each group against `harness/` and exactly how to write `learnings.md`.",
    "Then read `groups.md`, search `harness/`, write `learnings.md`, and run `node check.mjs` until it passes.",
    "The file is the deliverable. Your final reply is one short line.",
  ].join("\n")
