# Samskara

[![CI](https://github.com/vertexcover-io/samskara/actions/workflows/ci.yml/badge.svg)](https://github.com/vertexcover-io/samskara/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/vertexcover-io/samskara?label=release)](https://github.com/vertexcover-io/samskara/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

Samskara is a shared, searchable record of the work your team does with AI coding agents.

When a developer works with Claude Code or OpenCode, the full conversation is stored only on
their machine. After the pull request is merged, the rest of the team has no way to see what was
asked, which approaches were tried, or why the final change looks the way it does. Samskara
collects those sessions on a server the team operates and provides a web interface for browsing
and searching them.

Samskara supports Claude Code and OpenCode. It captures sessions only from folders a developer
has explicitly enabled, and no data leaves a machine until `samskara enable` has been run there.

## Contents

- [Overview](#overview)
- [What is captured](#what-is-captured)
- [How it works](#how-it-works)
- [Getting started](#getting-started)
- [Installing the CLI](#installing-the-cli)
- [Connecting the CLI to your account](#connecting-the-cli-to-your-account)
- [CLI reference](#cli-reference)
- [Running the server locally](#running-the-server-locally)
- [Deployment](#deployment)
- [Releases](#releases)
- [Contributing](#contributing)
- [License](#license)

## Overview

The web interface lists every captured session, grouped by project and by person. Opening a
session shows the conversation as it happened: each prompt, each response, each file the agent
changed, and the branch and pull request the work belonged to. Full-text search covers all
sessions, so a phrase from a conversation or a pull request number locates the relevant session
directly.

Sessions can be tagged for later retrieval, additional files can be attached to them, and an AI
reviewer can be run against a session to produce a written assessment.

## What is captured

Samskara stores four kinds of information for each session.

**Conversation.** Every prompt, every response, and every tool invocation in between, including
work delegated to sub-agents.

**Changed files.** Each file the agent created or edited, stored as it was before the change, as
it was after, and as a diff.

**Git context.** The branch, commits and pull request associated with the session, so that a
session can be located from the code it produced.

**Usage.** Token consumption and session duration.

## How it works

1. On each developer's machine, the `samskara` CLI runs a small background process. It monitors
   the enabled folders, detects new session activity, records what it has already sent, and
   uploads only the remainder. It reads nothing outside the enabled folders.
2. The server receives the sessions and stores them in a Postgres database.
3. The web interface reads from that database and is what the team uses in a browser.

Claude Code notifies Samskara at the start of each session. Samskara uses that notification to
restart the background process if it is not running, so capture continues after a reboot
without manual intervention.

## Getting started

Adoption has two parts. One person sets up a server for the team, following
[Deployment](#deployment). Each team member then installs the CLI, connects it to their account,
and enables capture in the folders they want to share:

```sh
npm i -g @vertexcover/samskara
samskara init          # choose the server and connect with a code from the web interface
cd ~/code/my-project
samskara enable        # begin capturing this folder
```

From that point, every session run in the folder appears in the web interface. The three
sections that follow describe each step in detail.

## Installing the CLI

Node 22 or newer is required.

```sh
npm i -g @vertexcover/samskara
```

Alternatively, with Homebrew:

```sh
brew trust vertexcover-io/tap
brew install vertexcover-io/tap/samskara
```

To install a specific version, name it: `npm i -g @vertexcover/samskara@0.5.1`. For machines
without access to the npm registry, each
[GitHub release](https://github.com/vertexcover-io/samskara/releases) includes the same package
as a downloadable file.

`samskara upgrade` replaces the installed version with the newest release.
`npm uninstall -g @vertexcover/samskara` removes it.

Before the move to npm, the CLI was published as `@samskara/cli`. If that package is installed,
remove it first with `npm uninstall -g @samskara/cli`. Both packages provide a command named
`samskara`, and npm will not install the new package over the old one.

## Connecting the CLI to your account

The CLI must be told which server to send sessions to and which account the sessions belong to.
This is done once, with a single-use code generated in the web interface.

1. Run `samskara init`. It prompts for the server address and the web interface address, then
   for a code.
2. Open the web interface in a browser and sign in with GitHub.
3. From the account menu, select **Pair the CLI**, then **Generate code**.
4. Enter the code in the terminal.

`init` also installs the Claude Code hook and starts the background process. The server issues
the CLI a token, stored at `~/.samskara/token` with permissions that allow only the current user
to read it. A code can be used once and has no expiry, but it is invalidated if the server
restarts before it is used.

The token expires after seven days by default; the server setting is `JWT_EXPIRES_IN`. When it
expires, uploads stop and Claude Code reports the condition at the next session start. Running
`samskara login` with a new code restores the connection.

Capture is then enabled per project:

```sh
cd ~/code/my-project
samskara enable
```

To move an already configured CLI to a different server, run `samskara init --force`. It backs
up local state, signs out, and disables capture in every folder. Log in and enable the folders
again afterwards.

## CLI reference

| Command | Purpose | Example |
|---|---|---|
| `init` | Select a server, connect to an account, install the Claude Code hook and start the background process. | `samskara init --server https://samskara.example.org --web https://samskara.example.org` |
| `login` | Connect again and obtain a new token. | `samskara login --code 4F7K2Q` |
| `logout` | Stop the background process and delete the token. | `samskara logout` |
| `enable [path]` | Begin capturing a folder. Sessions recorded before this point are skipped unless requested. | `samskara enable --all` |
| `disable [path]` | Stop capturing a folder. Sessions already uploaded remain on the server. | `samskara disable ~/code/old-project` |
| `reassign [path]` | Move a folder's sessions to a different project on the server. | `samskara reassign --to 42 --yes` |
| `status` | Report the connected server, the captured folders, their last sync time, and whether the background process is running. | `samskara status` |
| `search [query]` | Search sessions from the terminal and print links to the results. | `samskara search "rate limit" --here --open` |
| `tags add\|rm\|ls` | Add, remove or list the tags on a session. | `samskara tags add bug hotfix --session-id abc123` |
| `artifacts upload` | Attach files or directories to a session. | `samskara artifacts upload abc123 ./dist --base-dir .` |
| `review-session` | Run an AI review of a local session. Runs on the developer's machine, not the server. | `samskara review-session abc123 --harness claude` |
| `replay SESSION_ID` | Delete a session locally and on the server, then capture it again. | `samskara replay abc123` |
| `logs` | Show the background process log. | `samskara logs -f` |
| `restart` | Restart the background process. | `samskara restart` |
| `upgrade` | Install the newest release. | `samskara upgrade --check` |
| `watch` | Start the background process manually. | `samskara watch --foreground` |
| `install-hooks` / `uninstall-hooks` | Install or remove the Claude Code hook manually. | `samskara install-hooks` |

`--verbose` on any command prints diagnostic output. `samskara COMMAND --help` lists every flag.

`search` accepts the filters `--project`, `--user`, `--repo`, `--branch`, `--pr`, `--commit`,
`--range` and `--tags`. `--here` fills in the project, repository and branch from the current
folder.

All CLI state is stored under `~/.samskara`. Setting `SAMSKARA_PROFILE=NAME` switches to a fully
separate installation under `~/.samskara-NAME`, for keeping two configurations on one machine.

## Running the server locally

This section covers running Samskara on a development machine for evaluation or development.
For a server the team will use, see [Deployment](#deployment).

Sign-in is through GitHub, which requires a GitHub OAuth app: a registration that allows a
website to authenticate users with their GitHub accounts.

1. On GitHub, under **Settings, Developer settings, OAuth Apps**, create an app with homepage
   `http://localhost:8000` and callback `http://localhost:3000/api/auth/github/callback`.
   Generate a client secret and retain both the client id and the secret.
2. Run setup with the slug of your GitHub organisation:
   ```sh
   bun run setup YOUR_GITHUB_ORG_SLUG
   ```
   Setup installs dependencies, writes `.env`, starts Postgres, prepares the database and
   registers the organisation. On the first run it stops and requests two values it cannot
   generate: the OAuth client id and secret from step 1, and the AI reviewer's key. Add them to
   `.env` and run setup again.

   Setup is safe to repeat. It never replaces a secret that is already set, and it does not
   modify a database that already contains projects. Note that passing the organisation slug
   again re-enables automatic membership for that organisation, so omit the slug on later runs
   unless that is the intent.
3. Start the application:
   ```sh
   bun run dev    # API on :3000, web interface on :8000
   ```

Open http://localhost:8000 and sign in with GitHub. Only members of a registered GitHub
organisation can sign in. A super admin, a user with access to every project, can register
additional organisations from the web interface.

For development without an OAuth app, set `LOCAL_LOGIN_SECRET` in `.env`; the sign-in page then
offers a local login. This must never be set on a production deployment.

## Deployment

A production deployment consists of two containers on one Linux machine: the application and its
Postgres database. A provisioning script sets up the machine once. Thereafter, every release
deploys itself through GitHub Actions: the release is tested, built into a container image,
published to GitHub's container registry, pulled by the server, and verified with a health
check.

Prerequisites, the provisioning command, every configuration setting, and the GitHub secrets
and variables are documented in [deploy/README.md](deploy/README.md).

## Releases

All packages in this repository share a single version number. A release is cut with one command
and runs entirely on GitHub:

```sh
bun run release patch          # or minor, major, or an exact version such as 1.4.0
bun run release patch --watch  # follow the run from the terminal
```

The workflow runs the tests, increments the version in every package, tags the commit, publishes
the GitHub release with the CLI package attached, publishes the same package to npm as
`@vertexcover/samskara`, and triggers the deployment. A failed release leaves no tag behind.

A version with a pre-release suffix, such as `v1.4.0-rc.1`, is published as a pre-release on
GitHub and under npm's `next` tag. Pre-releases are not deployed.

## Contributing

Requirements: [Bun](https://bun.sh) 1.2.19 or newer, Node 22 or newer, and Docker.

The repository contains four packages.

| Package | Contents |
|---|---|
| `@samskara/core` | Shared types and the collectors that read sessions from Claude Code and OpenCode |
| `@vertexcover/samskara` (`packages/cli`) | The `samskara` command |
| `@samskara/server` | The API and database layer (Hono, Drizzle, Postgres with pgvector) |
| `@samskara/web` | The web interface (React and Vite) |

```sh
bun run dev           # API and web interface, rebuilding on change
bun run test          # unit tests; the server's tests require Docker
bun run e2e           # browser tests with Playwright, against a throwaway database
bun run lint          # biome
bun run typecheck
bun run cli -- status # run the CLI from source, with its own separate profile
bun run db:migrate    # bring the local database up to date
```

To use the CLI from a checkout as if it were installed, build it with
`bun run build --filter=@vertexcover/samskara`, then run `cd packages/cli && npm link`.

[CLAUDE.md](CLAUDE.md) covers contributor detail: worktrees, the column naming rule, migration
steps, message transformers and logging.

## License

[MIT](LICENSE) © Vertexcover
