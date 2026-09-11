All agent and contributor guidance lives in [CLAUDE.md](CLAUDE.md) — same rules for every
harness and human: setup, worktrees, database, logging, releases, and the TDD convention.

Orientation docs, in reading order:

1. [CLAUDE.md](CLAUDE.md) — contributor conventions (the entry point)
2. [docs/project_understanding.md](docs/project_understanding.md) — why this repo exists
3. [writeup/self-learning/RESUME.md](writeup/self-learning/RESUME.md) — where the current
   long-running initiative stands; read this before continuing any work described there
4. [README.md](README.md) — running the server, CLI, and web UI
5. [docs/playbook/](docs/playbook/) — imported playbooks (mission control, tenets, testing)

Skills live in `.claude/skills/` but their substance is tool-agnostic; any agent can follow
them.

If a task asks you to control Herdr (panes, workspaces, or other coding agents) or to
delegate work to other agents via Herdr, and no Herdr skill is already in your context,
read [`.claude/skills/herdr/SKILL.md`](.claude/skills/herdr/SKILL.md) first and follow it.
It teaches the `herdr` CLI: inspecting panes, starting agents, prompting them, reading
output, and waiting for completion. This applies to every harness (Claude Code, Codex,
OpenCode, and others).
