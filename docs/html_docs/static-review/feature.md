# Static session review

## What it is

After a coding session is captured, samskara reviews it and records what kind of session it
was: did the work land, how much did the agent fight, and what should be learned from it.
This doc covers the **static review** — the deterministic analyzer named `heuristic-v1`,
which is the only analyzer that exists today. It counts what the transcript shows (turn
boundaries, tool results, edit timing) and never reads prose, so the same session always
reviews the same way and no API key is ever required. An **AI review** is a planned,
distinct thing: a second analyzer with its own name that implements the same
`SessionAnalyzer` interface and would read the conversation with an LLM — it does not
exist yet, and the heuristic stays the floor so the feature never depends on one. Every
review row names its analyzer, so a verdict always says which kind produced it.

Its output is a review row plus candidate lessons that wait for a human to accept or
reject them; it is deliberately not a summary of what the session said.

## The flow end to end

1. **Trigger.** A review starts when someone calls `POST /api/sessions/:id/review` or runs
   `samskara review [SESSION_ID|--recent N]`. Both paths end in the same server function,
   `reviewAndPersist`. Nothing triggers a review on its own yet.
2. **Load.** The server loads the session with `getDetail`, the same call the web UI's
   session page uses — so a review sees exactly the rows a reader sees, and a user who
   cannot read a session cannot review it.
3. **Project.** The stored messages are mapped into a small neutral event vocabulary
   (`reviewEventsFromMessages`): turn, userMessage, toolCall, toolResult, edit, compaction,
   commit, pullRequest, tokens. Tool names join by `callId`, because results carry no name.
   Text survives only for user messages; the review never reads what anybody said, only when
   and in what order things happened.
4. **Analyze.** `HeuristicSessionAnalyzer` (`heuristic-v1`) folds the event stream into
   signals, then classifies friction and outcome from those signals.
5. **Extract.** `LearningExtractor` walks the same signals into candidate lessons, each for
   an agent audience or a human audience, each fingerprinted for deduplication.
6. **Persist.** The review upserts into `sessionReviews`, unique on `(sessionId, analyzer)`;
   each candidate upserts into `learnings` by fingerprint as `candidate`, so re-reviewing a
   session does not duplicate rows.
7. **Surface.** The `/learnings` web page lists candidates per project with Accept / Reject /
   Retire (human-check-only, editor-gated), and `samskara learn --write` exports accepted
   lessons into the repo's `.harness/knowledge/`.

## Triggers and entry points

| Entry point | Who | What it does |
|---|---|---|
| `POST /api/sessions/:id/review` | any signed-in user who can read the session | runs the review, persists it |
| `samskara review` / `samskara review --recent 5` | the CLI user | prints verdict + human feedback, persists server-side |
| `GET /api/learnings` | any user who can see the project | lists lessons (visibility-scoped) |
| `PATCH /api/learnings/:id/status` | project editors only | accept / reject / retire |

No background trigger exists: reviews run only when a person (or a person's script) asks.

## The data shape

The event vocabulary, one row per kind:

| Kind | Meaning |
|---|---|
| `turn` completed/aborted | a turn boundary; the last one decides the abort check |
| `userMessage` | a human prompt; `isMeta` marks harness injections, which are ignored |
| `toolCall` / `toolResult` | a tool invocation and its outcome, joined by `callId` |
| `edit` | a Write/Edit/MultiEdit/NotebookEdit call touching a file path |
| `compaction` | the transcript was compacted |
| `commit` / `pullRequest` | landing evidence — the work reached git |
| `tokens` | a token accounting line |

The analyzer's signals are the counted version of that stream: turns, aborted turns, user
prompts, tool calls, tool failures and rate, error loops (runs of consecutive same-tool
failures), edits per path, compactions, prompts-after-failures, rapid re-prompts, commits,
pull requests, and four token totals.

## The ontology

Every enumerated state the feature can be in, what each value means, and where it is
enforced. If a state is not in these lists, it cannot exist.

**Classifications the review produces** (enforced by check constraints on
`sessionReviews`/`learnings`, so the database rejects anything else). The review row also
carries `analyzer` — `heuristic-v1` today, which is the static analyzer this doc describes;
a review page shows this name so a reader always knows which kind of review produced the
verdict:

| Enum | Values | Meaning |
|---|---|---|
| outcome | `shipped` \| `productive` \| `struggled` \| `aborted` | did the work land, and how painful was the road |
| friction | `none` \| `moderate` \| `high` | how much the agent fought (independent of landing) |
| audience | `agent` \| `human` | who a lesson is written for |
| lesson status | `candidate` \| `accepted` \| `superseded` | the curation lifecycle; born `candidate` |

**Legal combinations.** Outcome and friction are independent — all twelve pairs can exist,
and `shipped` with `high` friction is a real, visible state. Within outcome itself,
`shipped` and `aborted` are mutually exclusive by construction: `aborted` requires zero
commits and `shipped` requires at least one commit or pull request, so no session can be
both. `productive` and `struggled` differ only by friction (high friction + nothing landed
= struggled).

**Input vocabularies** the projection consumes (enforced by zod at ingest):

| Enum | Values |
|---|---|
| msgType | `message` `toolCall` `toolResult` `progress` `hookCall` `queueOperation` `turnEvent` `compaction` `localCommand` `fileEvent` `usage` `systemEvent` `custom` |
| role | `user` `assistant` `system` `developer` `unknown` |
| toolResult status | `success` `failure` `cancelled` `unknown` |
| turn status | `completed` `aborted` `unknown` |
| artifact changeKind | `created` `edited` `editedUnknownBase` |

Two projection rules collapse inputs into review states: a turn whose status is `unknown`
reviews as `completed` (only `aborted` counts as aborted), and a user message with `isMeta`
set (or a non-empty subType) is ignored as a harness injection, not a human prompt.

**The lesson lifecycle.** Lessons are born `candidate` from any review, and only a project
editor (or owner/admin) can move them, via `PATCH /api/learnings/:id/status`. The intended
transitions: `candidate → accepted` (the Accept button), `candidate → superseded` (Reject),
`accepted → superseded` (Retire — the UI labels the state "Retired"), and
`superseded → candidate` (a "Back to candidate" button on retired rows). Note the server
accepts any of the three values from any
state — it validates the value and the editor's right to set it, not the transition. There
is no auto-accept: nothing but a human moves a lesson to accepted, ever.

**Lesson categories** (the extractor's taxonomy, fixed in code): `tool-retry` (a tool kept
failing before succeeding), `rework` (the same file edited many times), `supervision`
(prompts arriving while failures piled up), `prompt-shape`, `task-shape`, `context-hygiene`
(human-audience lessons about how the work was asked for).

## Decision rules, with their real thresholds

**Friction** — the first of the two verdicts, answered first:

- `high` if any error loop exists (3 or more consecutive failures of the same tool), or the
  tool failure rate exceeds 0.25, or 2 or more prompts arrived while failures were piling up
  (the human correcting course).
- `moderate` if the failure rate exceeds 0.10, or any turn was aborted.
- otherwise `none`.

**Outcome** — did the work land, in this precedence:

1. `aborted` — the final turn aborted and zero commits.
2. `shipped` — at least one commit or pull request, whatever the friction was; high-friction
   shipped sessions stay visible as "shipped with high friction" because both fields are
   reported side by side.
3. `struggled` — high friction with nothing landed.
4. `productive` — everything else.

**Lesson fingerprints** are `audience:category:subject`, so the same lesson from different
sessions converges on one row with an occurrence count instead of duplicating.

## Where the code is

| File | Job |
|---|---|
| `packages/core/src/review/events.ts` | the event vocabulary + projection from stored messages |
| `packages/core/src/review/analyzer.ts` | the heuristic fold: signals, friction, outcome |
| `packages/core/src/review/extractor.ts` | signals → candidate lessons + fingerprints |
| `packages/server/src/services/review.ts` | orchestration: load, review, persist |
| `packages/server/src/repositories/reviews.repo.ts` | sessionReviews + learnings persistence |
| `packages/server/src/routes/reviews.ts` | the HTTP surface |
| `packages/cli/src/commands/review.ts` | `samskara review` |
| `packages/cli/src/commands/learn.ts` | `samskara learn --write` |
| `packages/web/src/routes/Learnings.tsx` | the curation page |

## What is deliberately not there

- **`shipped` cannot happen today.** Step 2 loads the session's commits and pull requests,
  and step 3 throws them away — the projection maps messages only, so the landing evidence
  never reaches the analyzer. Every session is mislabeled `productive` or `struggled`. This
  is the top fix in the roadmap.
- **No automatic trigger.** Reviews run only on explicit command; the watcher never starts
  one (roadmap: review-on-quiet).
- **Subagent tracks are not separated.** A subagent's task prompt counts as a human prompt,
  and interleaving across tracks makes re-reviews wobble.
- **Occurrence counts inflate on re-review** of the same session, and lesson fingerprints
  use absolute file paths, so the same lesson on two machines is two lessons.
- **An LLM analyzer is planned as an option, not a requirement** — it would implement the
  same `SessionAnalyzer` interface under its own name (an `llm-*` analyzer, distinct from
  `heuristic-v1`); heuristics stay the floor.

## How to see it work by hand

With the local stack running (Postgres on :5433, server on :3000):

```sh
# review the most recent captured session
bun packages/cli/src/index.ts review --recent 1

# then look at what it produced
psql postgres://samskara:samskara@localhost:5433/samskara \
  -c 'select "sessionId", outcome, friction, summary from "sessionReviews" order by "analyzedAt" desc limit 5' \
  -c 'select "audience", "category", status, "occurrenceCount" from learnings limit 10'
```

The review prints its verdict and summary; the queries show the persisted rows and any
candidate lessons. Accepting a lesson is a button on `http://localhost:8000/learnings`.
