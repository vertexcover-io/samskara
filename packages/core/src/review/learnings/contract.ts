import { WRITING_RULES } from "../writingRules.js"
import { CAUSE_MAX, ONE_OFF_BELOW, WRITTEN_LIMITS } from "./format.js"
import { LEARNING_IMPACTS } from "./types.js"

/** Agent 1's instructions: put the new problems into groups by cause. */
export const GROUPER_CONTRACT = `# Group problems by cause

You get problems found in reviews of recorded AI agent sessions, and the learnings found so
far. Put problems with the same cause into one group.

## Your working directory

- \`problems.md\` — the new problems, each with an id (\`P1\`, \`P2\`, …): its title, class
  (who caught it), severity, where the fix goes, what happened, the learning the reviewer
  wrote, and quotes from the session.
- \`known-learnings.md\` — the learnings found so far, each with an id (\`K1\`, …), its title and its
  cause.
- \`groups.md\` — your answer, which you write.
- \`check.mjs\` — run \`node check.mjs\`. You are done when it says every problem is in a group.

## What a cause is

The cause is why it happened, not what was seen. "The implement skill has no rule to wait for
a background run to exit" is a cause; "the agent returned early" is what was seen.

Two problems share a cause when one fix would stop both of them.

- The same thing seen, for different reasons: different groups.
- Different things seen, for one reason: one group.
- Work the cause out from the title, description and learning. When a problem's cause is not
  clear, give it a group of its own. A group of one is fine.

## Joining a learning

When a group's cause is the cause of a learning in \`known-learnings.md\`, write that learning's id
under Joins. Only one group may join a given learning. Otherwise write \`new\`.

## groups.md

One section per group:

\`\`\`markdown
## Helpers stop before background runs finish

- **Joins:** new
- **Cause:** The implement skill never tells helper agents to wait for a test or build run to
  exit before they report, so they report while it is still running.
- **Problems:** P1, P4, P9
\`\`\`

- The heading is a short name for the cause.
- Cause: at most ${CAUSE_MAX} characters. It must make sense with every project name removed.
- Every problem is in exactly one group.

Your final reply is one short line, for example "groups.md ready: 12 groups".
`

export const buildGrouperPrompt = (): string =>
  [
    "You are grouping problems from AI agent session reviews by their cause.",
    "",
    "Read `CONTRACT.md` first: it says how to group and exactly how to write `groups.md`.",
    "Then read `problems.md` and `known-learnings.md`, write `groups.md`, and run `node check.mjs` until it passes.",
    "The file is the deliverable. Your final reply is one short line.",
  ].join("\n")

/** Agent 2's instructions: check each group against the harness and its evidence, drop or write it. */
export const WRITER_CONTRACT = `# Turn groups of problems into learnings

Each group in \`groups.md\` is a set of problems, from reviews of recorded AI agent sessions,
that share one cause. \`harness/\` is the code of the agent harness those sessions ran: its
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
2. Write one fix that would stop all of them, not only the new ones.
3. Set the priority again from all its problems. Keep the title unless it is wrong.

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
- **Title:** Helpers report while their test run is still going
- **Problem:** Coder and verify agents end their turn saying they are "waiting" on jest, so
  the orchestrator has to chase them, sometimes many times in one session.
- **Priority:** high — 9 problems in 6 sessions, and two shipped work nobody had tested
- **Impact:** wrong_result — two sessions shipped code whose tests had not finished running
- **Fix type:** skill
- **Fix:** In skills/implement/SKILL.md, under "Running tests", add: wait for the test command
  to exit and read its result before reporting; never report a run as pending.
- **In plain words:** Make helper agents wait for their tests to finish before they report.
- **How it helps:** Saves about 10 minutes a run of chasing helpers, and stops untested work
  from shipping.

## G2

- **Verdict:** drop
- **Why:** Step 1: the evidence shows a typo in one branch name that cost a minute, and
  nothing in the harness makes it likely again.
\`\`\`

- Title: at most ${WRITTEN_LIMITS.title} characters. It must make sense with every project
  name removed.
- Problem: what goes wrong and why it matters, at most ${WRITTEN_LIMITS.problem} characters.
  Tell one story, not many: pick the clearest time it happened and do not add a second one.
  Tell it in this order:
  1. What the agent was doing.
  2. What it did wrong.
  3. What happened because of it.
  4. What it should have done instead.
  Then one line on how often: "This happened in 11 sessions." A list of half-told cases is what
  makes a learning unreadable. For example: "The agent brought in the latest shared code, and
  34 tests started failing. It told the user they had nothing to do with its change, without
  checking. The user had to ask again before the real cause was found. It should have run the
  same tests on the code without its change: if they pass there, its change broke them. This
  happened in 11 sessions."
- Priority: the word, a dash, then one sentence why, at most ${WRITTEN_LIMITS.priorityReason}
  characters.
- Impact: one of ${LEARNING_IMPACTS.join(", ")}, a dash, then one sentence, at most
  ${WRITTEN_LIMITS.impactReason} characters.
- Fix: at most ${WRITTEN_LIMITS.fix} characters.
- In plain words: the fix in one sentence a person who never opened the code would follow,
  with no file paths or code, at most ${WRITTEN_LIMITS.fixSummary} characters. It is shown
  first; the Fix field's exact text sits under it.
- How it helps: one sentence on what changes once the fix is in, at most
  ${WRITTEN_LIMITS.howItHelps} characters. Say it in time saved or harm stopped.
- Why (for a drop): one sentence, at most ${WRITTEN_LIMITS.priorityReason} characters: which
  step dropped it, and what in the numbers or the evidence says so.

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
