# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Samskara serves individual developers, software teams, and engineering managers. Developers use it to preserve and explain the process behind code changes. Teams use it to make intent, planning, design, and implementation context available during collaboration and review. Engineering managers use it to understand how work was shaped, evaluated, and delivered without relying only on the final diff.

## Product Purpose

Samskara captures the process that generates code: the intent, planning, design artifacts, agent conversations, tool activity, and resulting implementation context. It helps people review code with more than a diff, recover the reasoning behind decisions, and retain useful engineering knowledge after a session ends.

Success means a reviewer can understand not only what changed, but why it changed, what alternatives were considered, how the work was executed, and which artifacts support the decision.

## Positioning

Samskara is a process-provenance layer for AI-assisted software development. Its distinct mechanism is connecting intent and planning artifacts to the agent sessions, subagents, tool activity, and code-generation process that followed—not merely storing code, diffs, or isolated chat transcripts.

## Operating Context

- Developers and teams work in Git repositories and use Claude Code as the first supported coding agent.
- The local watcher discovers Claude session files, captures them, and sends structured records to the Samskara server.
- Sessions may include main-agent messages, subagents, tool calls, tool results, and planning or design material.
- Users need to revisit context during code review, collaboration, handoff, debugging, and future maintenance.
- GitHub identity and organization membership are part of the current access model.
- The repository currently contains the capture CLI, server ingest API, database model, a read-only web API, and a web application for browsing captured work: projects, a filtered sessions index, and a session detail viewer with conversation, timeline, tool calls, and artifacts. Search, review workflows, and richer artifact rendering remain areas of development.

## Capabilities and Constraints

Confirmed capabilities:

- Claude Code session capture through the `samskara watch` CLI daemon.
- Structured persistence of sessions, messages, raw source records, tool calls, tool results, and subagents.
- Authenticated server ingest using an audience-scoped CLI token.
- GitHub OAuth web authentication with organization gating.
- Browsing captured work in the web UI: projects, a sessions index filtered by project, author, and date range with shareable URLs, and a session detail view presenting conversation, timeline, tool calls, and artifacts including subagent branches.
- CLI pairing and logout from the web account menu.
- A read-only web API (`/api/projects`, `/api/sessions`, `/api/sessions/:id`) scoped to the projects each user may read.

Product requirements from the team:

- Preserve the intent behind code, not just the code itself.
- Capture planning and design artifacts alongside execution context.
- Support better review tools that connect decisions, artifacts, agent activity, and implementation.
- Make the full process useful to individual developers, teams, and engineering managers.

Recommended constraints to confirm before production rollout:

- Treat captured sessions and artifacts as potentially sensitive engineering data; never expose them beyond the user's authorized projects or organizations.
- Provide explicit retention, deletion, export, and project-level visibility controls.
- Redact secrets and credentials before durable storage or transmission, with clear handling for raw-source records.
- Use least-privilege access for GitHub, CLI tokens, server APIs, and project sharing.
- Preserve idempotent, auditable ingestion so retries and rescans cannot duplicate or silently lose process history.
- Target WCAG 2.2 AA for the web experience, with keyboard navigation, visible focus, readable contrast, and non-color-only status communication.
- Keep the web product responsive and usable for dense review and timeline views at laptop and smaller viewport sizes.
- Confirm deployment, data residency, and self-hosting expectations before making infrastructure or compliance claims.

## Brand Commitments

- The product name is Samskara.
- The product should speak clearly about engineering intent, provenance, context, and review rather than presenting captured activity as raw telemetry alone.

## Evidence on Hand

- Product overview and architecture: `README.md`.
- Capture and ingest design: `.harness/features/watch-daemon-ingest/design.md`.
- Functional verification evidence: `.harness/features/watch-daemon-ingest/verification/proof-report.md`.
- Web application surface: `packages/web/src/App.tsx` defines the routes (`/login`, `/projects`,
  `/sessions`, `/sessions/:sessionId`, `/sync-status`) behind an auth guard; `packages/web/src/auth/`
  holds the session boundary, `packages/web/src/shell/` the app shell and account menu,
  `packages/web/src/session/` the session detail viewer, `packages/web/src/sync/` the sync-status
  page's sort/filter logic, and `packages/web/src/index.css` the Tailwind v4 design tokens.
- Current implementation supports Claude Code first; additional agent adapters, summarization, search, embeddings, MCP, and artifact storage are not yet established as shipped capabilities.

## Product Principles

1. Preserve intent with the implementation it produced.
2. Make review evidence richer than a diff without making it harder to scan.
3. Treat the development process as durable engineering knowledge, not disposable chat history.
4. Make provenance trustworthy through privacy, authorization, idempotency, and transparent data lifecycle controls.
5. Support both individual flow and team-level context without turning personal work into unbounded surveillance.

## Accessibility & Inclusion

The recommended baseline is WCAG 2.2 AA for the web product. The interface should support keyboard-first review, visible focus, sufficient contrast, scalable text, semantic structure, screen-reader-readable timelines and artifacts, and status communication that does not depend on color alone. These requirements should be confirmed alongside the production rollout constraints.
