# Deploying Samskara

Production is two containers on one Linux machine: the app and Postgres. Two pieces put it there,
run at different times.

| | Runs | Does |
|---|---|---|
| `deploy.py` | once per machine, by a person | installs Docker, writes the configuration, starts the stack, registers the org, schedules backups |
| `.github/workflows/deploy.yml` | on every release, by GitHub | tests, builds the image, pushes it to ghcr.io, tells the server to pull and restart |

The contract between them is small. Provisioning leaves `/opt/samskara` with
`docker-compose.yml`, `.env` and `.deploy.env`, plus a user in the `docker` group that the
workflow's key can log in as. The workflow touches nothing else.

## Contents

- [Before the first run](#before-the-first-run)
- [Provision a machine](#provision-a-machine)
- [Inputs](#inputs)
- [Wire up the workflow](#wire-up-the-workflow)
- [Day to day](#day-to-day)

## Before the first run

1. **A VM** running Ubuntu 22.04 or 24.04, with your SSH public key as root or a sudo user. That
   is the key provisioning logs in with. Nothing else needs to be installed on it.
2. **DNS**: an A record for your domain pointing at the VM. Caddy fetches the TLS certificate on
   first start and fails without it.
3. **A GitHub OAuth app** for your org with callback `https://DOMAIN/api/auth/github/callback`.
   Keep the client id and secret.
4. **The AI reviewer's key**: `OPENCODE_API_KEY`, or with `AI_REVIEW_HARNESS=claude` one of
   `CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_API_KEY`. The server refuses to start without it.
5. **An image on ghcr.io.** Provisioning ends by pulling it. The Deploy workflow must have
   published at least once, and the `samskara` package under the org's Packages must be public.
   On a fresh fork, run the workflow by hand with any tag: its deploy job fails until the server
   exists, but the build job publishes the image.
6. **A deploy key pair** for the workflow:
   ```sh
   ssh-keygen -t ed25519 -f ~/.ssh/samskara_deploy -N ""
   ```
   Provisioning installs the public half on the server. The private half goes to GitHub later.

## Provision a machine

```sh
cd deploy
pip install -r requirements.txt

export DEPLOY_HOST=1.2.3.4 DOMAIN=samskara.example.org ORG_SLUG=example-org \
       GITHUB_CLIENT_ID=... GITHUB_CLIENT_SECRET=... OPENCODE_API_KEY=... \
       DEPLOY_PUBKEY=~/.ssh/samskara_deploy.pub

pyinfra inventory.py deploy.py --dry   # show what would change
pyinfra inventory.py deploy.py -y      # apply
```

The dry run connects, gathers facts and lists every operation that would change something,
without writing anything. The apply runs the same list. When it finishes, the site answers at
`https://DOMAIN`.

Running it again is safe. `.env` and `.deploy.env` are written only when absent, so the generated
`JWT_SECRET` and database password never change. Everything else converges to the files in this
directory.

## Inputs

All inputs are environment variables, read by `inventory.py`. It stops with a message naming
anything required that is missing.

| Variable | Required | Meaning |
|---|---|---|
| `DEPLOY_HOST` | yes | IP or hostname of the VM |
| `DOMAIN` | yes | public domain the app is served on |
| `ORG_SLUG` | yes | GitHub org to register; only its members can sign in |
| `GITHUB_CLIENT_ID` | yes | from the OAuth app |
| `GITHUB_CLIENT_SECRET` | yes | from the OAuth app |
| `DEPLOY_PUBKEY` | yes | path to the deploy key's public half |
| `OPENCODE_API_KEY` | yes, by default | the AI reviewer's key |
| `AI_REVIEW_HARNESS` | no | `opencode` (default) or `claude`, which switches the key to `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` |
| `ADMIN_USER` | no | user provisioning logs in as; `root` by default |
| `SUPER_ADMIN_LOGINS` | no | comma-separated GitHub logins with access to every project |
| `SAMSKARA_IMAGE` | no | image to run; `ghcr.io/vertexcover-io/samskara` by default. A fork sets its own `ghcr.io/OWNER/REPO`, which is what its Deploy workflow publishes |
| `SAMSKARA_TAG` | no | image tag to start with; `latest` by default |
| `PROXY` | no | `caddy` (default) installs Caddy for TLS; `external` skips it when the platform already terminates TLS and forwards to port 3000 |
| `APP_USER` | no | user the workflow deploys as; `samskara` by default, created by provisioning |
| `APP_BIND` | no | interface the app is published on; derived from `PROXY` |

Secrets end up in one place, `/opt/samskara/.env` on the server, readable only by the deploy
user. They are never stored in GitHub.

## Wire up the workflow

Do this after provisioning, because the host key is read from the server. In the repository,
create an environment named `production` and add:

| Kind | Name | Value |
|---|---|---|
| secret | `SSH_PRIVATE_KEY` | contents of `~/.ssh/samskara_deploy` |
| secret | `SSH_HOST_KEY` | one line from `ssh-keyscan -t ed25519 DEPLOY_HOST` |
| variable | `DEPLOY_HOST` | the VM's IP or hostname |
| variable | `DOMAIN` | the public domain |
| variable | `DEPLOY_USER` | only when `APP_USER` was changed from the default |

From the command line, in a checkout of the repository and with `DEPLOY_HOST` and `DOMAIN`
still exported from provisioning:

```sh
gh api -X PUT "repos/{owner}/{repo}/environments/production"
gh secret set SSH_PRIVATE_KEY --env production < ~/.ssh/samskara_deploy
ssh-keyscan -t ed25519 "$DEPLOY_HOST" | gh secret set SSH_HOST_KEY --env production
gh variable set DEPLOY_HOST --env production --body "$DEPLOY_HOST"
gh variable set DOMAIN --env production --body "$DOMAIN"
```

Repository-level secrets and variables work too; the environment only adds the option of
required reviewers before a deploy.

If the package on ghcr.io was first pushed from a laptop rather than by the workflow, grant the
repository write access to it once: package settings, **Manage Actions access**, add the
repository with the Write role. A package first pushed by the workflow has this already.

Then run **Actions, Deploy, Run workflow** once with an existing tag. All three jobs should pass,
and the last step checks `https://DOMAIN/api/health`.

## Day to day

- **Release**: `bun run release patch` publishes a release, which deploys itself.
- **Deploy a specific tag, or roll back**: Actions, Deploy, Run workflow, enter the tag.
- **See what is running**: `cat /opt/samskara/.deploy.env` on the server.
- **Change a setting**: edit `/opt/samskara/.env`, then in `/opt/samskara` run
  `docker compose --env-file .env --env-file .deploy.env up -d app`.
- **Logs**: in `/opt/samskara`, `docker compose --env-file .env --env-file .deploy.env logs -f app`.
- **Backups**: nightly at 03:00 into `/opt/samskara/backups`, last seven kept. Copying them off
  the machine is up to you.
- **Rotate the deploy key**: generate a new pair, rerun provisioning with the new public half, and
  update `SSH_PRIVATE_KEY`.
- **Restore a backup**: a backup is a plain SQL dump, so it goes into an empty database. In
  `/opt/samskara`, with `COMPOSE="docker compose --env-file .env --env-file .deploy.env"`:
  ```sh
  $COMPOSE stop app
  $COMPOSE exec -T db psql -U samskara -d postgres -c 'drop database samskara' -c 'create database samskara'
  gunzip -c backups/samskara-YYYY-MM-DD.sql.gz | $COMPOSE exec -T db psql -U samskara -d samskara
  $COMPOSE up -d app
  ```
  Then sign in and check a project you know before trusting it.
- **New server**: provision it, copy the latest backup across and restore it as above, confirm
  the data in the browser against the new server's IP, then switch DNS and update `DEPLOY_HOST`
  and `SSH_HOST_KEY`.
