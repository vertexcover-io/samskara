# RESUME — Self-Learning Samskara

## AI session review — active initiative (2026-08-26)

Intent: a second review kind, run through the local harness (opencode), beside the static
`heuristic-v1`. UI "Analyze" on the Review tab when no AI review exists → harness runs the
review → stored under its own analyzer name. Output is lens-based, ontology-first:

- **timeline lens** — session compressed into navigable phases/events, every entry grounded
  (seq range + message ids) and deep-linkable into the conversation around that span.
- **human learnings lens** — what the person could have done better: communication,
  context, course-correction timing, task shape.
- **agent learnings lens** — efficiency (many turns where a shortcut existed), approach /
  alignment (failed paths, human-redirected work), tool/process misses; expandable.

Design rules settled up front:
- Lenses are individually schema'd (zod) and composed from a registry; adding a lens is
  additive. Analyzer name on every row = provenance (static vs AI never blurs).
- LLM output is untrusted: strict schema validation + grounding checks (references must
  resolve to real messages) before anything persists. Learnings still land as candidates —
  human-check-only curation unchanged.
- Harness-run, not raw API: server exports the session to a temp workspace, stages the
  contract (CONTRACT.md) and the pre-written review.xml template, runs the chosen reviewer
  CLI (opencode or claude — AI_REVIEW_HARNESS, per-run overridable) against a lean pointer
  prompt, and reads back the filled file. Model per harness via env
  (AI_REVIEW_MODEL; defaults glm-5.3-flash for opencode, sonnet for claude).
- Async: POST starts a job (in-memory registry v1, restart limitation documented), web
  polls; editor-gated like every write.
- Subagents deferred but designed-for: timeline entries + lens payloads carry track
  identity, so nested lanes, per-track sub-reviews, and an orchestration/spawning-efficiency
  lens are later additions, not rework.
- CLI: `samskara review <id> --ai` runs the loop headlessly with strict validation exit —
  agents can iterate until satisfied.
- Test session: ses_fc5f8ee50ffeQXLoFAlOe4Ub90, live from the UI before this is called done.

Checklist: `writeup/self-learning/board.csv` is the single machine-facing board — one row per
work item, stable ids (AI-*, TR-*, LA-*, SA-*, ME-*, DE-*), statuses todo/doing/done/blocked.
The mission-control page renders it 1-1 and `bun run test:scripts` (scripts/board.test.ts)
enforces the mapping — update the CSV, never the page alone.

Where the AI-review wave stands (2026-08-26, end of day):

- **Built and green (AI-1..AI-4):** lens ontology in core (201 tests: zod schemas, grounding
  gate, prompt registry, session exporter, XML contract + healing parser); server pipeline —
  visibility + editor gate, workspace export, harness runner (XDG-sandboxed opencode: empty
  data/config/cache home, auth copied in, so the reviewer cannot read the user's session
  database), XML parse → heal → zod → grounding → persist, in-memory job registry (4
  concurrent), routes POST /:id/analyze + GET /:id/aireview + GET /:id/analyze/:jobId
  (190 server tests); web Analyze button + polling + grounded timeline deep-links
  (252 web tests); CLI `samskara review --ai` (417 cli tests; 2 failures pre-exist on master).
- **AI-5 live loop, four real bugs found and fixed end-to-end:** (1) the prompt told the
  agent to write review.json while the pipeline parsed stdout — fixed, the reply's fenced
  block is the deliverable; (2) the JSON contract died whole on one oversized field —
  replaced by the XML contract with static healing (design stance recorded in
  project_understanding.md); (3) the exporter minted duplicate ids across tracks
  (`msg-0, msg-0, msg-1…`) — the reviewer reasonably distrusted them and cited original
  opencode ids from its own database; ids are now position-based, and the workspace also
  hides the real sessionId behind an alias; (4) **msb arg bugs** — runner was passing
  `${msbTimeoutMs}ms` (e.g. `595000ms`) and msb only accepts duration suffixes (`5s`); runner
  also wasn't staging auth.json into the workspace (silently swallowed because xdg-data/
  didn't exist) and the inner shell wasn't redirecting `</dev/null` so opencode blocked on
  stdin (proven-live from the internal kit's harness). Fixed: msb `--timeout` now `5s`-shaped,
  pipeline `mkdir -p` before copying auth, and `</dev/null` appended to the inner command
  with an MR5 test that locks it in.
- **AI-5 first end-to-end landing (ses_fc2090b58ffeGVKCQTEjoaynN2, 5 messages):** 16 s from
  spawn to `persisted`. Outcome=shipped, friction=none, summary correctly cites `msg-2`,
  `msg-3`, `msg-4` (export alias + position-based ids — agent did not reach for the host's
  opencode db). All four milestone flows worked. CI smoke test on the smallest session.
- **AI-5 big-session run (ses_fc5f8ee50ffeQXLoFAlOe4Ub90, 1501 records, ~280 KB export):**
  `harness_first_byte` arrived after **358 s** — review content was correctly grounded
  (every ref uses export `msg-N` ids in `0..1500`), but the final XML had a stray fragment
  (`<id>msg-523</id-434" />`) and multiple unclosed wrappers; the heal routine couldn't
  recover `humanLearnings` / `agentLearnings` element openers and the schema rejected it.
  Subagent audit of the VM exec.log flagged **export-shape** as the real cost: 280 KB doesn't
  fit in context, so the agent paged through it with 16 `node -e` probes (~65 s of bash
  overhead) before producing the review. Two cheap wins for AI-6: tighten excerpt caps
  in `export.ts` (drop `turnEvent`/`custom` from the export), and replace the "Read it fully
  first" rule in `prompt.ts:62` with "the export is a pre-shaped summary; cite seqs from
  there". Expected: 6 min → ~60 s on a 1500-record session.
- **Observability for long-running ops landed** (`scripts/ai-review-watch.sh`, MR-equivalent
  tests; CLAUDE.md "Long-running operations" section): pipeline emits named milestones
  (`workspace_ready`/`export_written`/`auth_staged`/`harness_spawning`/`harness_first_byte`/
  `harness_complete`/`xml_parsed`/`grounded`/`persisted`), registry tracks `lastEvent`,
  GET /:id/analyze/:jobId exposes it, CLI's `--ai` progress line names the latest milestone
  every 15 s. The watcher script tails server milestones AND the msb sandbox exec.log,
  counts tool-call repetitions, and flags `STUCK` (no first byte after threshold) and
  `THRASHING` (same tool > 5x). `--peek N` one-shots the agent's last N bash calls so a
  watching human can read the agent's mind without tailing the log themselves.
- Rebased onto master and committed as the AI-review wave (PR #29). The branch's migrations
  were renumbered in the rebase: `0022_optimal_venus` (learnings/sessionReviews) and
  `0023_tense_scream` (learningSessions) now sit on top of master's `0021_chubby_the_captain`.
- Code-review follow-ups (not blockers, logged here so they are not lost): `.claude/skills/`
  substance duplicates `docs/skills/` twins (tenet 2/4 sweep); `SessionDetail.tsx` at ~1,350
  lines wants splitting; milestone names want a union type instead of bare strings.

## Review UX + harness wave (2026-08-31)

- **Reviewer harness is a choice.** `AI_REVIEW_HARNESS` (opencode default) picks at boot; POST
  /:id/analyze accepts `{harness, model}` per run, and the "Analyze with AI" modal lists both
  with availability probed live (GET /api/reviewer-options). New claude lane:
  `createClaudeRunner` runs `claude -p` headless in the workspace with HOME +
  CLAUDE_CONFIG_DIR redirected (empty reviewer home; credentials staged best-effort;
  `CLAUDE_CODE_OAUTH_TOKEN` passes through — on macOS the Keychain holds the login, so the
  env token is the reliable path). Per-harness model defaults (opencode → glm-5.3-flash,
  claude → sonnet). The msb hard sandbox stays opencode-only.
- **Redo.** analyze accepts `force: true` (the upsert supersedes in place); the AI card has a
  Redo button through the same dialog; redo state renders on the card (running/failed with
  plain-language reasons); a reload rejoins running redos behind an existing review;
  `analyzedAt` (row updatedAt) now surfaces so a redo visibly moves the timestamp.
- **Job failures surface.** The UI polls GET /:id/analyze/:jobId beside the success probe;
  failed runs show per-code plain-language reasons, and a job lost to a restart says so.
  Ops lesson learned live three times: `tsx watch --env-file` does NOT re-read .env on
  reload, and every restart wipes the in-memory registry — reviews die silently mid-run.
  CLAUDE.md now tells agents to check for in-flight reviews before hot-reload-triggering
  edits.
- **Review contract v3.** `harnessLearnings` → `breadcrumbs` lens (query/command/path/
  procedure/tool) — the "Samskara itself" group is gone from the UI. The whole contract is
  staged into the workspace as `CONTRACT.md` and the prompt is a lean pointer to it, written
  in the playbook voice (tone_and_taste.md). Learnings must name a change, not a compliment.
  Healing got gentler where drops were noise: unknown categories default (recorded),
  nothing-entries keep with an empty detail (title stands in), `friction="none"` passes
  through (it was silently healed to moderate — real bug), and drop lines carry reasons,
  which the partial banner now shows instead of "incomplete".
- **UI simplification.** Verdict = color dot + plain sentence (enum words no longer render);
  static review card hidden; the whole timeline renders (top-7 cap removed) with per-entry
  duration + % of session + start offset; partial banner plain-language.
- **Reviewer transcript.** The pipeline lifts the reviewer's own session before workspace
  cleanup — claude's transcript jsonl from its redirected config dir, opencode's sqlite from
  the redirected XDG (covers msb, whose guest XDG lands in the mounted workspace) — and the
  card's "Reviewer session" modal renders it conversation-style (roles, text, inline tool
  calls). Evidence links resolve through `run.recordIds` (export alias msg-N → real message
  id) so they scroll to the cited record; the review-tab refresh no longer collapses content
  (the scroll-to-top bug).
- **Sandbox-log analysis of slow reviews** (glm-5.3-flash timing out at 595s on the big
  "Resume flow" session): the model's read-then-draft gap alone was 296–411s, python3
  probing failed in 100% of runs (the msb image has node only), and validation cascades ran
  to the deadline. CONTRACT.md now teaches write-forward assembly (summary first, sections
  as you go), node-only heredoc scripts, counts + validation in the same script, and
  "the file is the deliverable" when short on time; export excerpt caps tightened
  (100/60/40) to shrink the ingestion gap.

---

Machine-facing entry point. Read this before continuing any work on the self-learning mission.
Where this and `writeup/self-learning/mission-control.md` disagree, the mission-control page
wins and this file gets fixed.

## The mission

Turn samskara from "sessions are recorded and searchable" into "sessions are **learned from**":

1. Every captured session gets a **review** — outcome, signals, evidence — produced by a
   deterministic analyzer in `@samskara/core` (LLM optional later, never required).
2. Reviews yield **learnings** with two audiences: **agent** lessons (written back into the
   repo where the next session's agent reads them) and **human** feedback (what the person
   could have done better — prompts, course corrections, task shape).
3. Learnings are deduplicated, curated (candidate → accepted → superseded), and exported via
   `samskara learn --write` as `LEARNINGS.md` + `.harness/knowledge/` lessons.

## Design decisions (settled — do not reopen without owner ruling)

- **Heuristic-first analyzer.** Signals are computed from transcript structure (error loops,
  repeated tool failures, user corrections, edit churn, token totals), not LLM prose.
  Testable, deterministic, no API key. An LLM analyzer can later implement the same
  `SessionAnalyzer` interface; heuristics stay the floor.
- **Learnings live server-side as the team-shared store**, and are *exported* into repos on
  demand. The repo copy is generated, never hand-merged.
- **`@samskara/core` owns the domain** (review types, analyzer, extractor) so CLI and server
  share one vocabulary. Server owns storage + curation + API. CLI owns the write-back loop.
- **Reuse the `.harness/knowledge/` lesson format** (frontmatter: title/date/category/tags/
  applies_to/status/evidence_count) — it is this repo's existing learning currency. Generated
  INDEX must MERGE with hand-written lessons, never clobber (audit finding 2).
- **Promotion is human-check only (owner ruling, 2026-08-26).** No auto-accept, no threshold.
  The curation surface is the web UI: a per-project lessons view plus a cross-project
  "common lessons" view (same fingerprint in 2+ visible projects — tool-generic lessons like
  "Bash failed N times in a row" are not project knowledge, so they surface in the common
  view). `learn --write` keeps writing only accepted lessons.

## Audit verdicts (2026-08-25, five audits — loop, tests, autonomy, doc-only, doc-vs-code)

Read the findings as one ranked queue. Criticals block the loop from ever closing on real
data; majors corrupt it quietly; the rest is hygiene.

1. CRITICAL `shipped` outcome unreachable — nothing emits `commit`/`pullRequest` review
   events; `reviewFromDetail` discards `detail.commits`/`detail.pullRequests`
   (services/review.ts:32-36). Outcome = fiction until fixed.
2. CRITICAL `learn --write` clobbers `.harness/knowledge/INDEX.md` from server rows only;
   first realistic run (zero accepted learnings) writes an EMPTY index, orphaning the 4
   hand-written lessons (learn.ts:131-133; test L2 proves the empty path overwrites).
3. CRITICAL `/api/learnings` list + PATCH have no project-visibility scoping — any paired
   user reads/curates every project's learnings (routes/reviews.ts:41-60, unlike every
   session route).
4. CRITICAL `--project <name>` silently dropped (UUID-regex gate, learn.ts:57) → unfiltered
   fetch writes ALL projects' learnings into the current repo. Help text lies ("name or id").
5. CRITICAL no acceptance path: learnings born candidate, `learn` defaults to
   status=accepted, no CLI/web surface accepts → loop stalls at candidates forever.
6. MAJOR no automatic review trigger — reviews only on manual `samskara review`
   (watcher-side idle-sweep recommended; no job infra exists server-side).
7. MAJOR subagent tracks pollute analysis (task prompts counted as human prompts; nondeterministic
   interleaving across tracks; events.ts never reads trackId).
8. MAJOR occurrenceCount inflates on re-review of the SAME session (conflict update is
   unconditional +1; "seen 5x" would mean "reviewed 5 times"); title overwritten with
   latest session's embedded counts, losing magnitude history.
9. MAJOR absolute edit paths leak usernames into committed LEARNINGS.md and split
   fingerprints across machines (extractor.ts:100-105; artifact table already stores
   relativePath — review ignores it).
10. MAJOR extractor re-derives analyzer counters and has diverged (meta userMessage counted
    as work in one, not the other → learning with empty evidence; hardcoded >= 2 threshold).
11. MEDIUM stored messages carry no `tokens` field → server-side reviews report 0 tokens
    (double cast hides it; reviewEventsFromMessages reads message.tokens). Fold
    detail.tokenUsage in.
12. MEDIUM verify-review-loop.ts DELETES rows of whatever DATABASE_URL names and duplicates
    the suite — delete it (native-Postgres test mode already covers its purpose).
13. MINOR assorted: fingerprint lacks analyzer version; 4 constant-subject fingerprints mean
    one row per category with overwritten titles; day-stamped lesson filenames proliferate;
    reviewAndPersist not transactional; 201 on replace; aborted keyed off last turnEvent
    only; R8→R10 test-number gap; several dead exports; RESUME said GET
    /api/projects/:id/learnings but implementation mounted /api/learnings.

Doc audits: understanding doc 7/10 (unbuilt things in present tense), doc-vs-code 7/10.
Both fixed same session (pgvector wording, feed-back tenses, reverts→edit churn,
SourceAdapter→AgentPlugin, artifact flow split).

## Current state

- Phase 0 (foundation) DONE: skills, playbooks, understanding doc, AGENTS.md, alignment gaps.
- Docker-free local stack DONE: `scripts/local-pg.sh` + `src/lib/test-db.ts` throwaway dbs.
- Core review domain DONE (127 tests), server storage+API DONE, CLI review + learn built.
- Human-check-only promotion RULED (2026-08-26) and its surface BUILT: `/learnings` web page
  (per-project view with Accept/Reject/Retire, cross-project "common" view), learnings API
  visibility-scoped (V7), status changes editor-gated (V8), common aggregation (V9).
  Server routes now use `validate("json", ...)` so the hono client types the PATCH.
- Audit fixes landed so far: #3 (visibility scoping), #5 (acceptance surface — UI, not
  auto-accept, per ruling), #12 (verify-review-loop.ts deleted). Remaining criticals: #1
  (commit/PR events), #2 (INDEX clobber), #4 (--project name resolution).
- DUAL ROADMAPS LANDED (2026-08-26, two subagents — GLM-5.3 from understanding, MiniMax-M3
  from code): `writeup/self-learning/roadmaps/{A-from-understanding,B-from-existing}.md`.
  B re-verified the 13 findings with file:line evidence (#3, #5, #12 fixed; rest broken).
  A added five forward capabilities (opencode capture, semantic retrieval, efficacy
  measurement, auto-review on quiet, agent-side delivery) as workstreams W1-W8 with a
  dependency table. Synthesis lives on the mission-control page and wins over this file.
- DOGFOODING LIVE (2026-08-26): server :3000 / web :8000 on local Postgres :5433 (JWT_SECRET
  + placeholder OAuth secret written to .env by hand — `bun run setup` was never completed),
  CLI paired headlessly (web JWT minted from .env → /api/auth/cli-code → login --code),
  capture enabled for this repo (project `vertexcover-io-samskara`, backfill from 2026-08-19).
- OPENCODE CAPTURE LANDED (increment 1, 2026-08-26, MiniMax-M3 subagent): collector plugin
  `packages/core/src/collector/plugins/opencode.ts` reads opencode's sqlite db (bun:sqlite in
  dev / better-sqlite3 on Node via driver shim), `source` gate loosened to
  `z.enum(["claude_code","opencode"])`, checkpoints are a per-source discriminated union,
  watcher iterates the plugin registry instead of hard-coding claude. Verified live: this
  repo's sessions (10 opencode + 4 claude at last count) in the web DB under
  `vertexcover-io-samskara`. Build note: `writeup/self-learning/roadmaps/B-opencode-build.md`.
  Gates: lint/typecheck/test:core green; 2 cli test failures pre-exist on master.

## What happens next (synthesized order, mission-control wins)

1. ~~opencode capture source~~ DONE (increment 1 above). Next slice candidates: artifacts
   from opencode file-text parts, review-side track handling for opencode subagents.
2. Fix 1: emit commit/PR events in `reviewFromDetail`; core test: commit events → shipped.
3. Fix 2: writeLearnings merges existing `.harness/knowledge/lessons/**` frontmatter into
   INDEX (never clobber); stable slugs; prune only files it owns. Then Fix 4: `--project`
   resolves name/slug (fail loudly).
4. Fix 6: watcher idle-session review sweep in the 10s cycle (= A's W3).
5. Fix 7-9: per-track projection, relative-path edits, occurrence-per-session semantics.
6. Fix 10-11: share counters between analyzer+extractor, fold tokenUsage into review input.
7. Then A's W5 (human feedback on session page), W7 (pgvector similar-sessions), W8
   (efficacy deltas). Close the loop on real data, then docs, then hk-writeup page.

## Improvement backlog (doc-grounded audit, 2026-08-26 — feed-back half first)

Ranked from the project-understanding doc alone; top three are cheapest-per-leverage and
two overlap the audit queue:

1. **Deliver accepted lessons to the next agent's eyes** — a CLAUDE.md line / SessionStart
   pointer at `.harness/knowledge/` in enabled projects. The loop's agent half is open
   until something reads what `learn --write` writes. (Small.)
2. = audit fix 1 (commit/PR events → truthful shipped verdict).
3. = audit fix 2 extended (write-back is supersession-aware: retired lessons come out,
   duplicates never ship twice).
4. Automatic review trigger (watcher idle-sweep). = audit fix 6.
5. Semantic similar-session retrieval via the provisioned-but-unused pgvector store.
6. Loop-efficacy measurement: signals before/after each accepted lesson.
7. Per-session human feedback surfaced in the session page (extractor already emits it).
8. PR-annotated trajectory view (attempts and reverts alongside the diff).
9. Post-opt-in privacy: redaction, excluded paths, retention.
10. Token-burn-without-landing view (needs 2).
11. Second source adapter through a real plugin registry seam.
12. Propose-a-common-lesson into another project's candidates (never auto-push).
13. Per-trend human digests.

## Conventions that bind this work

- **No Docker on this machine (owner ruling, 2026-08-25).** Never start Docker Desktop. The
  stack is native Postgres via `scripts/local-pg.sh start` (port 5433, same DATABASE_URL as
  compose). Server tests: `DATABASE_URL=postgres://samskara:samskara@localhost:5433/samskara
  bun run test:server` — `src/lib/test-db.ts` creates a throwaway database per run
  (`samskara_test_<pid>_<rand>`) so the dev data is never touched; suites without the env var
  fall back to testcontainers and skip without Docker.
- TDD — write the test first (CLAUDE.md).
- DB columns camelCase (naming.grit + biome plugin).
- `createLogger` everywhere; no console.log in app code.
- Docs live in `docs/`; skills are thin pointers.
