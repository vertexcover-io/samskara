import { createHash } from "node:crypto"
import type { SessionExport } from "../lenses/export.js"
import { LIMITS } from "./reviewMd.js"

/**
 * The part of the review contract a user may change: the goal, the steps and the rules for
 * finding problems. Generic on purpose — it knows nothing about any one system. A user's own
 * prompt is merged into this text (see `buildMergePrompt`); the output part below never is.
 */
export const BASE_REVIEW_INSTRUCTIONS = `# How to review

## Goal

Find what went wrong or wasted time in this session. The reader has never seen the session,
so every problem must make sense on its own.

## Step 1: find leads

A lead is something worth a closer look, not yet a problem. Look for these:

- A human message that corrects, redirects, repeats an earlier ask, or asks what something means
- A question the agent asked when the answer was already in the session
- The person interrupting or stopping the agent
- Three or more failures of the same kind of command
- The same command run three or more times
- A gap over 5 minutes. It counts only if no helper agent was running and no question was
  waiting for an answer
- Blocked permissions, hook errors, API errors, a helper agent that died
- The agent saying something is done, and later it turns out it was not
- Checks run against fake, mocked or injected data
- The same fact worked out twice

## Step 2: check each lead

Read about 10 records before and 10 after it. Answer: what was the agent doing, what
happened, what happened next, what did it cost. Drop a lead that turns out to be fine.

## Step 3: one root cause, one problem

Leads with the same cause become one problem, with each incident listed under its Evidence.

## Step 4: label each problem

- Class: missed (nobody caught it; report only if it matters), blocked (a human had to step
  in), slow (the agent recovered but lost time), caught (a check found it; report only if a
  rule would have prevented it).
- Severity: high, medium or low, with one sentence why. A wrong result ranks above lost time.
  A human catching it does not make it less serious.
- Fix type: where the fix goes. skill (a skill or instruction file the agent follows), code (a
  code fix or a breadcrumb in the code), project_guidelines (the project's standing notes every
  agent reads, such as AGENTS.md or CLAUDE.md), knowledge_base (knowledge worth writing down
  once, looked up when needed), human (the person, not the system, should change, for
  example by giving the context up front).
- When the person corrects the agent without saying why, do not guess the reason. Quote what
  they asked for.

## Rules

- Mark an estimate as an estimate.
- Name a change, never a compliment.
- Judge this session only, not sessions it talks about.
- If the evidence is thin, say less.
`

/**
 * The part nobody changes: where things are, and the exact shape of review.md. Code reads the
 * file back field by field (`parseReviewMd`) and checks every quote against the session
 * (`checkEvidence`), so this text and those functions must agree.
 */
export const REVIEW_OUTPUT_CONTRACT = `# Files and output (fixed)

## Your working directory

- \`leads.md\` — leads in this session, one per line with an id (\`L1\`, \`L2\`, …): what readers
  found going through every piece of it, then what code found. This is Step 1, done for you. A
  lead is a place to look, not yet a problem, and its own summary may be wrong.
- \`session.json\` — the session, one record per line. Every record has \`id\` (\`msg-N\`),
  \`seq\`, \`msgType\`, \`role\`, \`track\`, \`ts\` (epoch ms), and \`text\`, or for a tool call
  \`toolName\`, \`input\`, \`status\` and \`output\`. It can be large: search it with grep or a
  short node script, and read ranges around what you look up. Do not read it whole.
- \`review.md\` — the review you write. It starts with the header filled with placeholders.
- \`leads-answered.md\` — your answer to every lead, which you write.
- \`check.mjs\` — lists the leads you have not answered yet.

Do Steps 2 to 4 for the leads: check each one in the session, put leads with the same cause
into one problem, and write the real problems in review.md. Answer every lead in \`leads-answered.md\`, one line each:
\`- L4: problem — <title of its problem>\` or \`- L4: dropped — <why it did not happen or is
fine>\`. A lead under "Human messages" is the person's own message: drop it only by quoting
it, \`- L4: dropped — msg-3911 — "their exact words" — why it is an ordinary answer\`. Then run
\`node check.mjs\`. You are not done until it says all are accounted for.

## review.md

Write exactly this shape. A word in [brackets] takes only the listed values.

\`\`\`markdown
# Review

- **Outcome:** [shipped | productive | struggled | aborted]
- **Friction:** [none | moderate | high]

## Summary

What the session set out to do and how it went, in one short paragraph.

## Problems

### Said the tests passed without running them

- **Class:** [missed | blocked | slow | caught]
- **Severity:** [high | medium | low] — a wrong result would have shipped
- **Fix type:** [skill | code | project_guidelines | knowledge_base | human]
- **Description:** The agent was expected to run the tests before reporting. It reported them
  as passing, but no test command ran in the session.
- **Evidence:**
  - msg-134 — "all tests pass" — this is wrong: no test command ran between msg-120 and msg-134.
  - msg-198 to msg-201 — "tests are green" — the same claim again, still with no test run.
- **Learning:** Run the test command and read its result before saying tests pass.
- **Extra:** name: value; name: value
\`\`\`

## Each field

- Title (the \`###\` line): a short name for the problem, at most ${LIMITS.title} characters.
  It must still make sense with every project name removed.
- Description: what was expected, then what happened instead. One or two sentences, at most
  ${LIMITS.description} characters.
- Evidence: the proof that this is a problem. Write \`- **Evidence:**\` once, then list each
  incident under it, one indented line each, at most ${LIMITS.evidencePerProblem}. Each line is a message id (\`msg-134\`) or a range
  written \`msg-120 to msg-134\` of at most ${LIMITS.evidenceRange} messages, then the quote in
  double quotes, then one sentence saying what is wrong about it. The quote must be words
  that really appear in those records (their text, input or output), at least
  ${LIMITS.quoteMin} and at most ${LIMITS.quote} characters; skip words with \`…\`. The
  sentence after it is at most ${LIMITS.why} characters.
- Learning: what should change so this does not happen again. One sentence, at most
  ${LIMITS.learning} characters.
- Severity: the word, a dash, then one sentence why, at most ${LIMITS.severityReason}
  characters.
- Extra: every field listed under "Extra fields" in your instructions, on every problem, as
  \`name: value\` pairs separated by \`;\`, each value at most ${LIMITS.extraValue}
  characters. A problem missing one is thrown away. Leave the line out only when your
  instructions list no extra fields.
- Summary: at most ${LIMITS.summary} characters; anything longer is cut off.
- At most ${LIMITS.problems} problems. If there is nothing to change, write
  \`Nothing to change.\` under \`## Problems\`.

Code reads this file back. A problem with a missing field, a word outside its list, a field
over its limit, or a quote that is not at its ids is thrown away. So cite only ids that exist,
and delete a claim you cannot cite.

## How to write

- Write the way you would say it out loud to the person next to you.
- Say what happened plainly, with the real names, numbers and error messages.
- Use everyday words: use, fix, broke. Not utilize, leverage, remediate.
- No grading words like robust, crucial or honest. Say why it matters instead.
- Do not squeeze: write "the test suite failed twice", not "tests ×2 ✗".
- The reader remembers nothing: a file name or id always comes with what it is.

Your final reply is one short line, for example "review.md ready: 6 problems".
`

/** The contract the reviewer reads: the (possibly merged) instructions, then the fixed part. */
export const assembleReviewContract = (instructions: string): string =>
  `${instructions.trimEnd()}\n\n---\n\n${REVIEW_OUTPUT_CONTRACT}`

/** What review.md holds before the reviewer writes it. */
export const reviewMdSkeleton = (): string => `# Review

- **Outcome:** [shipped | productive | struggled | aborted]
- **Friction:** [none | moderate | high]

## Summary

## Problems
`

/**
 * The short prompt the reviewer starts from. Everything it needs is in files it can re-read,
 * so the prompt only points at them.
 */
export const buildProblemReviewPrompt = (meta: { readonly title: string }): string =>
  [
    "You are reviewing a recorded AI agent session to find its problems.",
    "",
    `Session: ${meta.title}`,
    "",
    "Read `CONTRACT.md` first: it says how to review and exactly how to write `review.md`.",
    "Then check the leads in `leads.md` against `session.json`, write the real problems in `review.md`, and answer every lead in `leads-answered.md`.",
    "The file is the deliverable. Your final reply is one short line.",
  ].join("\n")

/** Short content hash, to know when a prompt or the base has changed since the last merge. */
export const contentHash = (text: string): string =>
  createHash("sha256").update(text).digest("hex").slice(0, 16)

/** The version of the base a merge was made against; a new base means merging again. */
export const baseReviewVersion = (): string => contentHash(BASE_REVIEW_INSTRUCTIONS)

/**
 * The prompt for the merge agent: fold a user's prompt, which may be any shape, into our base
 * instructions. It runs once when a prompt is set or changes; the result is saved and reused,
 * so every review with the same prompt runs the same instructions.
 */
export const buildMergePrompt = (): string =>
  [
    "You merge two review prompts into one.",
    "",
    "Your working directory has:",
    "- `BASE.md` — our instructions for reviewing a recorded AI agent session: goal, steps, rules.",
    "- `USER.md` — the user's own prompt. It can be in any form: a list, a paragraph, a whole prompt.",
    "",
    "Write two files:",
    "",
    "1. `MERGED.md` — BASE.md with the user's prompt applied. Keep BASE.md's headings (Goal, Step 1 to 4, Rules).",
    "   - Add a `## About this system` section after Goal with everything the user says about their system.",
    "   - Go through the user's prompt point by point. For each point decide one of: add it as a new step or rule, extend an existing one, append to an existing one, or remove one.",
    "   - If the user and BASE.md say opposite things, or you are not sure which to follow, follow the user. Never keep both.",
    "   - If the user asks for extra output, add a `## Extra fields` section with one line per field, exactly `- name: what goes in it`, where name is one short lowercase word. Nothing else about output: the output format is fixed and not yours to change, so drop any other output instructions and note that in CHANGES.md.",
    "   - Do not add anything the user did not ask for.",
    "2. `CHANGES.md` — what you changed, one line each, like `Added to Step 1: …`, `Extended rule: …`, `Removed: …`, `Ignored (output is fixed): …`.",
    "",
    "Your final reply is one short line.",
  ].join("\n")

/**
 * session.json as the reviewer reads it: the meta, then one record per line. Still one JSON
 * document, but a grep for an id or a word returns the whole record it is in — which is how a
 * reviewer searches a session too large to read.
 */
export const sessionJsonText = (exported: SessionExport): string =>
  [
    `{"meta":${JSON.stringify(exported.meta)},"records":[`,
    exported.records.map((record) => JSON.stringify(record)).join(",\n"),
    "]}",
    "",
  ].join("\n")
