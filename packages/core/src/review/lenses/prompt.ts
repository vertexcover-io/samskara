/**
 * The lean pointer-prompt for a harness agent reviewing one exported session. The full
 * contract lives in the workspace as `CONTRACT.md` (core's `reviewContractMd`), staged by
 * the pipeline beside `session.json` and the pre-written `review.xml` — so this prompt only
 * names the three files, states the one inviolable deliverable rule, and defers everything
 * else to the file the agent can re-read at any point without spending starting context.
 * Deterministic: the same options always produce the same prompt, byte for byte.
 */
export type ReviewPromptOptions = {
  readonly sessionMeta: {
    readonly sessionId: string
    readonly title: string
    readonly startedAt?: string
    readonly endedAt?: string
    readonly source: string
  }
}

const sessionSection = (meta: ReviewPromptOptions["sessionMeta"]): string[] => [
  "## Session",
  "",
  `- sessionId: ${meta.sessionId}`,
  `- title: ${meta.title}`,
  `- source: ${meta.source}`,
  ...(meta.startedAt === undefined ? [] : [`- startedAt: ${meta.startedAt}`]),
  ...(meta.endedAt === undefined ? [] : [`- endedAt: ${meta.endedAt}`]),
  "",
]

const WORKSPACE = [
  "## Your working directory",
  "",
  "- `CONTRACT.md` — the review contract: the exact verdict vocabulary, section rules, attribution and grounding rules, and how to assemble the file. Read it first; re-read any rule whenever you need it.",
  "- `session.json` — the exported session under review. The only data source: every citable record with seq, id (msg-N), role, tool name, result status, text excerpt, track, ts. Judge this session — not the task of reviewing, and not any session the transcript merely talks about.",
  "- `review.xml` — the pre-written skeleton you fill in, in place, section by section.",
  "",
]

const DELIVERABLE = [
  "## Deliverable",
  "",
  'Fill in `review.xml` following `CONTRACT.md`. The file is the deliverable — never emit the whole review in one message; append one well-formed element at a time. Your final reply is one short line (e.g. "review.xml ready: 7 timeline entries").',
  "",
]

export const buildReviewPrompt = (options: ReviewPromptOptions): string =>
  [
    "You are reviewing a recorded AI coding session.",
    "",
    ...sessionSection(options.sessionMeta),
    ...WORKSPACE,
    ...DELIVERABLE,
  ]
    .join("\n")
    .trimEnd()
