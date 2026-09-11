# Samskara — Project Understanding

Read this first. It tells you *why*; [CLAUDE.md](../CLAUDE.md) and the [README](../README.md)
tell you *how*. When a decision isn't spelled out by the code, this is the context that should
inform your judgment. Format borrowed from the VM OSS project understanding doc, blended with
this repo's own contributor docs.

## What this is, in one sentence

Samskara **records what AI coding agents actually did, and makes it searchable** — across
projects, machines, and the whole team — so that the work agents do stops being invisible
exhaust and becomes a queryable record.

## Why it exists

Every AI coding session already writes a transcript somewhere local — Claude Code under
`~/.claude/projects`, other agents in their own corners. Those files are per-machine,
unreadable at a glance, and gone the moment anyone needs them. Meanwhile the *interesting*
questions are team-scale:

- What did the agent change in this PR, beyond the diff — what did it try and revert?
- Which sessions burn tokens without landing work?
- When a teammate's agent hit this same wall last week, how did it get out?

Samskara watches those transcript sources, ships opted-in sessions to a server you run, and
gives a web UI and CLI to browse and search them — conversations, tool calls, artifacts
(before/after/diff), git context (branch, commits, PRs), token usage. Storage is Postgres
with full-text search today; the pgvector image in compose is provisioned for future
semantic search, not used by any query yet.

The payoff:

- **Visibility** — the agent's actual trajectory (attempts, failures, back-and-forth edits) is captured, not
  just the final diff.
- **Team memory** — sessions are searchable across everyone, so the third person to hit a
  problem finds the first two.
- **Opt-in privacy** — nothing leaves a machine until `samskara enable` runs in that folder;
  capture is consent, per project.
- **Own your data** — self-hosted server, your Postgres, your org's GitHub login as the only
  door.

## The core idea to hold in your head

There is one central artifact: the **session**. A session is one recorded agent conversation
with its tool calls, artifacts, and git context. Everything in the platform exists to collect
sessions (core collector + CLI watcher), store and index them (server, Postgres + pgvector,
full-text search), or help humans and agents query them (web UI, `samskara search`).

**Adding a new agent source = adding a plugin** (`AgentPlugin` in `@samskara/core`'s
collector framework; Claude Code is the first plugin). The seam is real — each plugin owns
its discovery and parsing, the watcher driver is source-blind — but today the watcher
injects the one plugin directly, so a second source also means wiring it there.

## The main objective: from recorded sessions to learned sessions

The long-term goal every design decision should serve: **turn the session archive into a
feedback loop that makes the next session better.**

Recording is table stakes. The trajectory the platform is on:

1. **Collect** (done) — transcripts, artifacts, git context, tokens.
2. **Find** (done) — search across projects, users, branches; shareable filtered views.
3. **Understand** (building now) — systematic *session review*: each captured session gets an
   outcome (did the work land?), signals (error loops, edit churn, user corrections, token
   totals), and extracted learnings. See [`writeup/self-learning/`](../writeup/self-learning/)
   and [RESUME.md](../writeup/self-learning/RESUME.md) for the live mission.
4. **Feed back** (building now) — learnings flow two ways:
   - **To agents**: curated lessons are written into the repo (`.harness/knowledge/`) by
     `samskara learn --write` — a manual command today; pointing the next session's agent at
     those files (a CLAUDE.md line, a hook) is part of the remaining work.
   - **To humans**: per-session feedback on what the human could have done better — sharper
     prompts, earlier course corrections, tasks that should have been split. Aggregated
     per-trend digests are roadmap, not built.

A change that makes sessions more captured, more findable, more understood, or more fed-back
is moving in the right direction. A change that only makes the archive bigger without making
it wiser is not.

## The four components (and why the split matters)

| Component | Dir | Role | The "why" of the boundary |
|-----------|-----|------|---------------------------|
| **core** | `packages/core/` | Shared types, the collector framework (`AgentPlugin` + Claude plugin), logging factory | *What a session is* — domain vocabulary, no I/O policy, reusable by CLI and server alike |
| **cli** | `packages/cli/` | The `samskara` binary — pairing, capture opt-in, the background watcher | *The machine side* — consent, checkpoints, resumable upload; everything it stores lives in `~/.samskara` |
| **server** | `packages/server/` | Hono API on Node, Drizzle + postgres-js + pgvector | *The team side* — auth via GitHub org, ingest, search, the one Postgres everyone shares |
| **web** | `packages/web/` | Vite + React + Tailwind UI | *Where humans look* — browse, search, drill into one session's conversation/timeline/artifacts |

**core vs server** is the split people trip on: core answers *what is a session*; server answers
*where the team's sessions live*. The CLI never talks to Postgres; the server never watches a
filesystem.

## The signature flow (worth memorizing)

```
Claude Code writes transcript     ~/.claude/projects/...
   → watcher (CLI, background) polls, per-session checkpoint
   → POST /api/ingest  with new messages                [server]
   → POST /api/artifacts with file content (queued + retried
     separately, so an artifact failure never blocks transcript sync)
   → Postgres: sessions, messages, artifacts, git context,
     token usage; full-text search indexes
   → web UI /sessions + `samskara search` read it back
```

A `SessionStart` hook keeps the watcher alive: starting a Claude Code session guarantees the
watcher is running. Capture is opt-in per folder (`samskara enable`); by default the clock
starts at enable-time, so enabling an old project does not retroactively upload history
(`--all` / `--sync-from` opt into backfill).

## Domain vocabulary

- **Project** — one enabled folder, registered with the server. **Repo** and **branch** are
  per-session git context.
- **Session** — one recorded agent conversation. **Message** — one turn (prompt, reply, or
  tool call), including subagent branches.
- **Artifact** — a file the agent created or edited: before, after, and the diff.
- **Ingest checkpoint** — per-session watermark in `~/.samskara` so the watcher only sends
  what is new.
- **Pairing code** — one-shot code from the web UI that exchanges for a CLI token.
- **Session review** *(new)* — a structured analysis of one session: outcome, signals,
  evidence. Two kinds exist, and every review row names its **analyzer** so a reader always
  knows which produced the verdict: **static review** (`heuristic-v1`) is a deterministic
  count over transcript structure — no LLM, no API key, same answer every run; **AI
  review** is harness-run — the server exports the session into a throwaway workspace
  (with the contract staged as `CONTRACT.md`) and a reviewer agent — opencode or claude,
  chosen per run — analyzes it, so the reviewer is an agent reading an agent's work.
  **Lens** *(new)* — one named dimension of an AI review (timeline, human learnings, agent
  learnings, breadcrumbs), individually schema'd and composed from a registry; adding a
  lens is additive.
- **Grounding** *(new)* — the auditability contract of AI reviews: every timeline entry and
  learning carries references (seq ranges, message ids) that must resolve to real session
  records before anything persists, and the UI deep-links from any claim back to the
  conversation span it came from. An ungounded claim is rejected, not displayed.
- **XML for model-facing contracts, JSON for machine-facing ones** *(design stance)* — when
  an LLM produces structured output, the contract is XML, not JSON. Models emit XML more
  reliably (it is the most-trained serialization in pretraining), XML breaks *locally*
  (one malformed entry can be dropped while its siblings survive) where JSON breaks
  *totally* (a single bad character makes the whole document unparseable), and a known tag
  vocabulary admits static healing before parsing: balance unclosed tags, escape stray
  `&`/`<`, truncate overlong text, salvage well-formed elements. Healing plus partial
  salvage is what makes cheap models usable for analysis. Internally nothing changes — the
  parsed payload feeds the same zod schema, grounding gate, and storage as before; only the
  wire format between model and parser is XML.
- **Learning** *(new)* — a curated, deduplicated lesson extracted from reviews,
  with an audience (agent or human) and a status lifecycle (candidate → accepted → superseded).
  Learnings are the currency of the feedback loop. Both review kinds feed the same
  pipeline; corroboration across analyzers converges on one row by fingerprint.
- **Subagent tracks** — reviews are track-aware by design: lens payloads carry track
  identity, so nested timelines, per-track sub-reviews, and an orchestration lens
  (inefficiency in *spawning* subagents) are future additions, not schema rework.

## Where to go next

- **Contributor conventions** (worktrees, db naming, seeds, logging, releases) →
  [CLAUDE.md](../CLAUDE.md)
- **Running it** (setup, CLI reference, web UI) → [README](../README.md)
- **The self-learning mission** (live status) → [RESUME.md](../writeup/self-learning/RESUME.md) and
  [`writeup/self-learning/`](../writeup/self-learning/)
- **How a specific flow works end to end** → `.claude/skills/hk-breadcrumb-creator/` writes
  breadcrumbs into `docs/breadcrumb_analysis/`; `hk-follow-breadcrumb` reads them first
- **Standing rules this repo imports** → [`docs/playbook/tenets.md`](playbook/tenets.md)
