# Samskara

[![CI](https://github.com/vertexcover-io/samskara/actions/workflows/ci.yml/badge.svg)](https://github.com/vertexcover-io/samskara/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/vertexcover-io/samskara?label=release)](https://github.com/vertexcover-io/samskara/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

Samskara records what your AI coding agent did and makes it searchable for the whole team.

Claude Code and OpenCode keep a transcript of every session on the machine they ran on. Those
transcripts are local, scattered and hard to read. Samskara watches them, sends the sessions you
opt into to a server your team runs, and gives everyone a web UI to browse and search them across
projects, machines and people.

Nothing leaves a machine until someone runs `samskara enable` in a folder.

## Contents

- [How it works](#how-it-works)
- [What gets captured](#what-gets-captured)
- [Development](#development)
- [Install the CLI](#install-the-cli)
- [Pair the CLI with the server](#pair-the-cli-with-the-server)
- [CLI commands](#cli-commands)
- [Run the server locally](#run-the-server-locally)
- [Deployment](#deployment)
- [Releases](#releases)
- [License](#license)

## How it works

```
  Developer machine                              Team server
 ┌──────────────────────────────────────┐       ┌─────────────────────────────┐
 │  Claude Code      OpenCode           │       │                             │
 │  ~/.claude/…      opencode.db        │       │   API  ──▶  Postgres        │
 │        │              │              │ HTTPS │    ▲          + pgvector    │
 │        ▼              ▼              │ ────▶ │    │                        │
 │   samskara watcher (background)      │       │   Web UI: browse & search   │
 │   reads only enabled folders         │       │                             │
 └──────────────────────────────────────┘       └─────────────────────────────┘
```

1. A developer installs the CLI once and pairs it with the server.
2. They run `samskara enable` in each project folder they want captured.
3. A background watcher reads new session activity, remembers what it has already sent, and
   uploads only the rest.
4. The server stores sessions in Postgres and serves the web UI where the team reads and searches
   them.

A Claude Code hook restarts the watcher whenever a session starts, so capture keeps working after
reboots without anyone thinking about it.

## What gets captured

- **The conversation**: prompts, replies and every tool call in between, including subagent
  branches.
- **Artifacts**: files the agent created or edited, stored as before, after and diff.
- **Git context**: the branch, commits and pull requests a session touched.
- **Usage**: tokens consumed and session duration.

## Development

Requirements: [Bun](https://bun.sh) 1.2.19+, Node 22+, Docker.

| Package | Holds |
|---|---|
| `@samskara/core` | Shared types and the collector plugins for Claude Code and OpenCode |
| `@samskara/cli` | The `samskara` binary |
| `@samskara/server` | Hono API, Drizzle, Postgres with pgvector |
| `@samskara/web` | React and Vite UI |

```sh
bun run dev           # API and web in watch mode
bun run test          # unit tests; the server's need Docker
bun run e2e           # Playwright, on a throwaway database
bun run lint          # biome
bun run typecheck
bun run cli -- status # the CLI from source, on its own profile
bun run db:migrate    # bring the local database up to date
```

To work on the CLI from a checkout, `bun run build --filter=@samskara/cli` then
`cd packages/cli && npm link`.

[CLAUDE.md](CLAUDE.md) covers contributor detail: worktrees, the database naming rule, migration
steps, message transformers and logging.

## Install the CLI

Needs Node 22 or newer. The CLI is not on npm; every release attaches a tarball and this URL
always points at the newest one:

```sh
npm i -g https://github.com/vertexcover-io/samskara/releases/latest/download/samskara-cli.tgz
```

To pin a version, use its own asset, for example `v0.5.0`:

```sh
npm i -g https://github.com/vertexcover-io/samskara/releases/download/v0.5.0/samskara-cli-0.5.0.tgz
```

Later, `samskara upgrade` installs the newest release over the current one, and
`npm uninstall -g @samskara/cli` removes it.

## Pair the CLI with the server

Pairing links the CLI on your machine to your account on the server. It happens once.

1. Run `samskara init`. It asks for the server URL and the web URL, then for a pairing code.
2. Open the web URL in a browser and sign in with GitHub.
3. From the account menu choose **Pair the CLI**, then **Generate code**.
4. Paste the code into the terminal.

`init` then installs the Claude Code hook and starts the watcher. The token it receives is stored
at `~/.samskara/token`, readable only by you. A code works once and never expires, but it is
invalidated if the server restarts before it is used.

To finish, turn capture on in a project:

```sh
cd ~/code/my-project
samskara enable
```

To move an already configured CLI to a different server, run `samskara init --force`. It backs up
local state, signs out and disables every project, after which you log in and enable again.

## CLI commands

| Command | What it does | Example |
|---|---|---|
| `init` | Choose a server, pair, install the hook, start the watcher | `samskara init --server https://samskara.example.org --web https://samskara.example.org` |
| `login` | Pair again and store a new token | `samskara login --code 4F7K2Q` |
| `logout` | Stop the watcher and delete the token | `samskara logout` |
| `enable [path]` | Start capturing a folder. Sessions before now are skipped unless asked for | `samskara enable --all` |
| `disable [path]` | Stop capturing a folder. Uploaded sessions stay on the server | `samskara disable ~/code/old-project` |
| `reassign [path]` | Move a folder's sessions to another project | `samskara reassign --to 42 --yes` |
| `status` | Server URLs, projects, capture state, last sync, watcher state | `samskara status` |
| `search [query]` | Search sessions from the terminal and print their URLs | `samskara search "rate limit" --here --open` |
| `tags add\|rm\|ls` | Read or change a session's tags | `samskara tags add bug hotfix --session-id abc123` |
| `artifacts upload` | Attach files or directories to a session | `samskara artifacts upload abc123 ./dist --base-dir .` |
| `review-session` | Run an AI review of a local session, without the server | `samskara review-session abc123 --harness claude` |
| `replay SESSION_ID` | Delete a session on both sides and capture it again | `samskara replay abc123` |
| `logs` | Show the watcher log | `samskara logs -f` |
| `restart` | Restart the watcher | `samskara restart` |
| `upgrade` | Install the newest release | `samskara upgrade --check` |
| `watch` | Start the watcher by hand | `samskara watch --foreground` |
| `install-hooks` / `uninstall-hooks` | Manage the Claude Code hook by hand | `samskara install-hooks` |

Add `--verbose` to any command for debug output. `samskara COMMAND --help` lists every flag.

`search` takes filters such as `--project`, `--user`, `--repo`, `--branch`, `--pr`, `--commit`,
`--range` and `--tags`, and `--here` fills project, repo and branch from the current checkout.

Everything the CLI stores lives in `~/.samskara`. Set `SAMSKARA_PROFILE=NAME` to keep a second,
fully separate install at `~/.samskara-NAME`.

## Run the server locally

1. Create a GitHub OAuth app under **Settings, Developer settings, OAuth Apps** with homepage
   `http://localhost:8000` and callback `http://localhost:3000/api/auth/github/callback`.
   Generate a client secret.
2. Run setup with your GitHub org slug:
   ```sh
   bun run setup YOUR_GITHUB_ORG_SLUG
   ```
   It installs dependencies, writes `.env`, starts Postgres, migrates, seeds and registers the
   org. On the first run it stops and asks for the OAuth client id and secret and the AI
   reviewer's key. Add them to `.env` and run it again. Re-running is always safe.
3. Start everything:
   ```sh
   bun run dev    # API on :3000, web UI on :8000
   ```

Open http://localhost:8000 and sign in with GitHub. Only members of a registered GitHub org can
sign in; a super admin can register more orgs from the web UI.

For development without an OAuth app, set `LOCAL_LOGIN_SECRET` in `.env` and the sign-in page
offers a local login. Never set it on a real deployment.

## Deployment

Production is two containers on one Linux machine: the app and Postgres. A provisioning script
sets a machine up once, and after that every release deploys itself through GitHub Actions:

```
test  ──▶  build image, push to ghcr.io  ──▶  server pulls and restarts  ──▶  health check
```

Prerequisites, the provisioning command, every input, the GitHub secrets and variables, and
day-to-day operations are in [deploy/README.md](deploy/README.md).

## Releases

Every package shares one version. One command cuts a release, and nothing runs on your machine:

```sh
bun run release patch          # or minor, major, or 1.4.0
bun run release patch --watch  # stream the run
```

The workflow tests first, then bumps the manifests, tags, publishes the GitHub release with the
CLI tarball, and dispatches the deploy. A failed release leaves no tag behind. A tag with a
pre-release suffix, such as `v1.4.0-rc.1`, publishes as a pre-release and is not deployed.

## License

[MIT](LICENSE) © Vertexcover
