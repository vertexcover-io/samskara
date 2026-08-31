# Self-learning samskara — session log

Append-only, one entry per session, newest first. Same voice as the mission-control page.

## 2026-08-25 — session 1 (opencode, glm-5.3)

Foundation laid and build started. Imported 33 skills from the internal skills kit (breadcrumb
creator/follower, audit family, writeup, RCA, gitleaks, mock-first, local-run-spec, skill
creator); copied oss playbooks + tenets into `docs/playbook/`; wrote
`docs/project_understanding.md` in the house format; added root `AGENTS.md`. Alignment
subagent rated the repo 9/10 with 17 spot-checked claims; fixed its top three gaps (stale
`TODO(milestone)` placeholders in services/routes barrels, README `.env.example` wording).
Mission control opened at `writeup/self-learning/`; RESUME.md tracks machine-facing state.
Next: core review domain, tests first.

## 2026-08-25 — session 2 (opencode, glm-5.3): audit pass

Owner directive: audit before more building. Five read-only subagent audits — loop
completeness, test quality, autonomy, doc-only understanding, doc-vs-code. 13 findings
(5 critical): shipped-outcome unreachable (no commit/PR events), INDEX clobber, unscoped
learnings API, silent --project drop, no acceptance path. Doc fixes applied same hour
(pgvector wording, feed-back tenses, reverts→edit churn, SourceAdapter→AgentPlugin,
artifact flow split). Mission-control page (HTML, house shell) opened for the owner;
RESUME carries the ranked fix queue. Next: fix 1 (commit/PR events) through fix 5
(acceptance path), then the watcher sweep, then close the loop on this repo's real
sessions.

## 2026-08-26 — session 3 (opencode, glm-5.3): the ruling and the curation page

The owner ruled on the one open decision: lessons promote by human check only, never by a
count. Built the surface for that check — a Lessons page in the web UI with a per-project
view (Accept, Reject, Retire) and a common-across-projects view that groups the same lesson
from two or more projects into one row with no buttons, because a shared lesson is curated
per project by its own people. While wiring it: the learnings API now shows a viewer only
what their projects show them, and only a project's editors can change a status (tests V7,
V8, V9). Deleted the leftover database-wiping verifier script. Three audit findings closed
(#3, #5, #12); the three worst still open are the fictional shipped verdict, the index
clobber, and the silent --project drop.

## 2026-08-26 — session 4 (opencode, glm-5.3): improvement audit + cross-repo comparison

Improvement audit run from the project-understanding doc only (13 ranked items; the three
cheapest are all in the feed-back half — deliver accepted lessons to the next agent's
eyes, make the shipped verdict read real commits, make the write-back supersession-aware).
Folded into RESUME's queue as items 1, 2 and a new cheap item (CLAUDE.md pointer).

Cross-repo skill comparison run per the new skill (created here — it did not exist in
the internal skills kit) against an internal kit checkout and an oss checkout:

| What | Source | Decision | Why |
|---|---|---|---|
| hk-chart-validation, hk-mobile-app-ui-validation, hk-pdf-export, hk-ui-gaps-analysis | internal kit .claude/skills | copy | tool-agnostic validation/audit skills |
| docs/patterns/ (12 files) | internal kit docs | copy | tool-agnostic engineering patterns (bookkeeping never kills the run; close the loop before claiming; no fabricated verdicts from infra failures) |
| docs/testing_process/ (3 files) | internal kit docs | copy | testing philosophy, portable as-is |
| docs/task_brief_template.md | internal kit docs | copy | writing guidance; its TONE.md reference already maps to this repo's canonical tone doc |
| docs/routing_guidance.md | internal kit docs | skip | about the internal kit's own bench and agent quotas |
| docs/guides/, wiki/, adoption/, solutions/, loops/, walkthrough.md, Quickstart.md, breadcrumb_analysis/ | internal kit docs | skip | about the internal kit's own systems; would be noise here |
| fable_roadmap TONE.md | internal kit docs | skip | superseded — this repo points at docs/playbook/tone_and_taste.md (oss canonical) |
| all docs/skills, all docs/playbook | oss | present | nothing missing — full copy landed earlier |

After the copy: 48 skills in .claude/skills, oss skills and playbooks confirmed complete.
Zero gaps remain against either source.

## 2026-08-26 — session 5 (opencode, glm-5.3): dual roadmaps + dogfooding live

Two roadmap subagents via herdr (tabs as breadcrumbs, 0→3): GLM-5.3 built the forward
roadmap from the understanding doc (workstreams W1-W8 + dependency table), MiniMax-M3
audited what exists and re-verified all 13 findings with file:line evidence — #3, #5, #12
fixed; the four criticals and six majors stand. Both landed in
`writeup/self-learning/roadmaps/`; synthesis is on the mission-control page and re-orders
the queue: opencode capture goes first (no dependencies, and it is the only way this repo
— all-opencode — ever feeds the loop real data).

Samskara now runs on itself: stack live (API :3000, web :8000, Postgres :5433), CLI paired
headlessly (web JWT minted from .env → cli-code → login), capture enabled for this repo
(project `vertexcover-io-samskara`, backfill from 2026-08-19). The claude-side watcher is
armed but this folder has zero claude transcripts — the emptiness is the argument for the
new item 1. Opencode's session store mapped for the plugin: sqlite at
`~/.local/share/opencode/opencode.db`, tables session/message/part, `session.directory`
= cwd, `session.parent_id` = subagent linkage, per-session agent/model/token columns.

## 2026-08-26 — session 6 (opencode, glm-5.3): AI-5 lands, four-bug-fix cascade, watcher tool

AI-5 finally closed end-to-end after a cascade of four runtime bugs in the msb harness.
The CI smoke test (5-message "PONG reply" session) passed in 16 seconds — outcome
shipped, friction none, summary correctly cited export `msg-N` ids (not opencode's
internal ids), proving the alias + position-id scheme held. The big 1501-message session
also produced a well-grounded review but the XML emit was malformed and the parser
rejected it; subagent audit of the VM exec.log showed the agent spent ~6 minutes paging
through 280 KB of records with 16 `node -e` probes — the export is too big for context
and the "Read it fully first" prompt rule forces the over-probing. AI-6 will tighten the
export and the prompt.

Bugs fixed this session:
1. msb `--timeout` format — runner was passing `${msbTimeoutMs}ms` (e.g. `595000ms`); msb
   only accepts duration suffixes (`Xs`/`Xm`/`Xh`). msb errored out as "invalid digit found
   in string" and the harness never started.
2. auth not staged into the VM — `createMsbWrappedRunner` was supposed to read auth.json
   from the workspace, but the pipeline never wrote it there. `.catch(() => undefined)`
   swallowed the copyFile error and opencode ran without auth and hung silently.
3. `xdg-data/opencode/` directory not pre-created — copyFile would have failed anyway even
   without the `.catch`. Fixed with `mkdir -p` before the copy.
4. `</dev/null>` on the inner command — opencode (like most agent CLIs) reads stdin in a
   loop, and msb does not propagate the host's DEVNULL stdin into the guest. Without the
   in-guest `</dev/null` redirect, the guest hangs to the msb timeout producing no
   output. (The internal kit's harness carries the same `</dev/null` — proven live there.)
   Locked in with an MR5 test that asserts the redirect is present.

Observability rebuilt around long-running ops: pipeline emits named milestones
(`workspace_ready` → `export_written` → `auth_staged` → `harness_spawning` →
`harness_first_byte` → `harness_complete` → `xml_parsed` → `grounded` → `persisted`),
registry tracks `lastEvent`, GET /:id/analyze/:jobId exposes it, CLI progress line names
the latest milestone every 15 s. New tool `scripts/ai-review-watch.sh` tails server
milestones AND the msb sandbox exec.log, counts tool-call repetitions, and flags `STUCK`
(no first byte after threshold) and `THRASHING` (same tool > 5x). `scripts/ai-review-watch.sh
--peek N` dumps the agent's last N bash commands so a watching human can read the agent's
mind without tailing the log themselves. Pattern documented in CLAUDE.md's
"Long-running operations" section — to be enforced on every future async build.
