# Roadmap A — from understanding (forward)

Derived from `docs/project_understanding.md` — the why and the mission — not from a code audit.
The audit-fix queue lives in RESUME.md; where a workstream overlaps it, that is noted. Forward
means: what the mission implies should exist next, in the order the mission itself argues for.

## The mission, in three sentences

Every captured AI coding session gets a deterministic review — outcome, signals, evidence — that
never needs an LLM to be trusted. Reviews yield lessons for two audiences: agents (written back
into the repo the next session reads) and humans (told what they could have done better). Lessons
are curated by human check only and exported via `samskara learn --write`, turning the archive
from a record of what agents did into a feedback loop that changes what they do next.

## Phases, and why in this order

| Phase | Goal | Workstreams | Why now |
|---|---|---|---|
| 1. Truth | Reviews mean what they say; export destroys nothing | W1, W2 | Every later capability compounds on review truth — fiction propagates into lessons, retrieval, and efficacy claims |
| 2. The loop runs itself | Review and both delivery halves run unattended | W3, W4, W5 | Capture is already automatic; judging and delivery are the two halves still requiring a human to remember a command |
| 3. Breadth | Second capture source through a real plugin seam | W6 | The `AgentPlugin` seam is designed-for but unwired; every day without it, opencode sessions are invisible exhaust |
| 4. Memory | The archive answers "who hit this before?" | W7 | Needs corpus breadth (Phase 3) to be useful; pgvector is already provisioned and idle |
| 5. Proof | The mission's claim becomes a measurement | W8 | Efficacy deltas need delivered lessons plus time-distant sessions — only meaningful after Phases 1–2 |

## Workstreams

### W1 — Truthful reviews
- Outcome: outcome/signals/evidence computed from real data — commit/PR events reach the analyzer
  (`shipped` reachable), subagent tracks separated from human turns, tokens counted server-side.
- First step: emit commit/PR review events in `reviewFromDetail`; core test: commit events → shipped (= RESUME critical 1).
- Depends on: nothing.
- Done when: a real session from this repo reviews end-to-end with a truthful verdict and non-zero token totals.

### W2 — Safe, supersession-aware write-back
- Outcome: `learn --write` merges hand-written `.harness/knowledge/` lessons into INDEX (never
  clobbers), prunes only files it owns, `--project` by name resolves or fails loudly (= RESUME criticals 2, 4).
- First step: `writeLearnings` merges existing lesson frontmatter into the generated INDEX.
- Depends on: W1 (lessons must stand on truthful reviews before they ship anywhere).
- Done when: a write on this repo leaves the 4 hand-written lessons listed and retired lessons removed.

### W3 — Automatic review on session quiet *(new capability)*
- Outcome: the watcher's existing poll loop detects a session whose transcript has gone quiet and
  reviews it then — the front of the loop runs with no manual command (= RESUME major 6).
- First step: add idle detection (no transcript growth for N minutes) to the watcher cycle, triggering the review POST; idempotent re-review.
- Depends on: W1 (never auto-run fictional reviews at scale).
- Done when: captured sessions carry reviews within minutes of going quiet, verified on this repo's live sessions for a week.

### W4 — Agent-side delivery of accepted lessons *(new capability)*
- Outcome: the next session's agent actually reads what `learn --write` writes — a pointer in
  enabled projects (CLAUDE.md line and/or SessionStart hook) at `.harness/knowledge/`.
- First step: owner picks the mechanism (static CLAUDE.md line vs hook-injected context, or both); prototype the static line.
- Depends on: W2 (what gets delivered must be safe to write).
- Done when: a fresh agent session in an enabled repo demonstrably cites/applies an accepted lesson; delivery is opt-in per project.

### W5 — Human feedback surfaced *(new capability, half-built)*
- Outcome: the human audience receives its lessons — per-session feedback on `/sessions/:id`
  (extractor already emits it), then aggregated per-trend digests.
- First step: render the review's human-feedback block on the session page.
- Depends on: W1; digests additionally on W3 (needs volume of automatic reviews).
- Done when: session pages show human feedback and a digest view ranks recurring human patterns per project.

### W6 — opencode as a capture source *(new capability)*
- Outcome: opencode sessions flow through watcher/server/UI like Claude sessions today, via a
  real plugin registry seam — the watcher stops injecting the one plugin directly.
- First step: spike an opencode `AgentPlugin` (its session storage differs from `~/.claude/projects`; discovery + parsing owned by the plugin) plus registry wiring in the watcher.
- Depends on: nothing hard; benefits from W3 (a new source becomes reviewable automatically).
- Done when: `samskara enable` + real opencode usage yields searchable sessions with conversation, git context, tokens; the watcher is source-blind in practice, not just by design.

### W7 — Semantic similar-session retrieval *(new capability)*
- Outcome: the provisioned-but-unused pgvector store becomes load-bearing — "when a teammate's
  agent hit this wall last week, how did it get out?" is a meaning-based query, not just keywords.
- First step: owner picks an embedding source (local/no-key floor fits the heuristic-first precedent); embed session summaries/error signatures; `GET /api/sessions/:id/similar` + web panel.
- Depends on: W1 (retrieval over truthful data); W6 soft (breadth makes similarity useful).
- Done when: a session with a repeated failure surfaces the earlier occurrences in the similar-sessions panel; visibility boundaries respected cross-project.

### W8 — Loop-efficacy measurement *(new capability)*
- Outcome: the mission's claim — accepted lessons make the next session better — becomes a
  measured before/after delta per lesson (error loops, edit churn, tokens, outcome rate).
- First step: snapshot per-session signals at review time (so deltas are computable later), then
  define the cohort: sessions matching a lesson's `applies_to` before acceptance vs after W4 delivery.
- Depends on: W3 (consistent automatic reviews), W4 (delivery is the intervention).
- Done when: the lessons page shows a before/after delta — or an honest "insufficient data" — for each accepted lesson, with the methodology written down.

## New capability directions the understanding implies (code does not have them)

- **Auto-review on quiet** (W3), **agent-side delivery** (W4), **human feedback surface** (W5) —
  the doc's "Feed back" stage is only half-built: lessons are exported but nothing consumes them.
- **opencode capture** (W6) — the doc says "adding a new agent source = adding a plugin"; the
  seam exists, the registry does not; opencode transcripts are currently invisible to samskara.
- **Semantic retrieval** (W7) — pgvector is named in compose and docs but "not used by any query yet."
- **Efficacy measurement** (W8) — the doc's north star ("makes the next session better") has no instrument today.
- Later, not scheduled: post-opt-in privacy (redaction, excluded paths, retention), PR-annotated
  trajectory view, token-burn-without-landing view, propose-a-common-lesson across projects.

## Risks and open questions for the owner

- Risks: heuristic reviews may be too blunt as volume grows (LLM analyzer later behind the same
  `SessionAnalyzer` interface — needs an API-key ruling); auto-review can amplify known counting
  bugs (occurrence-per-session semantics must land first or "seen N×" stays a lie); efficacy
  deltas have confounds (model versions, task mix — report with cohort sizes, never as proof);
  embeddings widen the privacy surface beyond the opt-in bargain; opencode storage format drift;
  human-check-only curation is a deliberate bottleneck — watch the candidate queue depth.
- Open questions: delivery mechanism for W4 (CLAUDE.md line, hook, or both)? embedding source for
  W7 (local model vs API)? do embeddings ever include artifact content, or transcript only? does
  agent delivery extend symmetrically to opencode (AGENTS.md) once W6 lands? minimum cohort size
  before an efficacy delta is reported at all? is auto-review opt-out per project?

## Dependencies at a glance

| Workstream | Depends on |
|---|---|
| W1 truthful reviews | — |
| W2 safe write-back | W1 |
| W3 auto-review on quiet | W1 |
| W4 agent delivery | W2 |
| W5 human feedback surface | W1 (digests: W3) |
| W6 opencode source | — (W3 soft) |
| W7 semantic retrieval | W1, W6 (soft) |
| W8 efficacy measurement | W3, W4 |
