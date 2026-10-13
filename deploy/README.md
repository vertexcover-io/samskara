# Deploying Samskara

A production deployment of Samskara consists of two containers on one Linux machine: the
application and its Postgres database. Two components put it there, and they run at different
times.

`deploy.py` is a provisioning script that a person runs once per machine. It installs Docker,
writes the configuration, starts the application and the database, registers the GitHub
organisation and schedules nightly backups.

`.github/workflows/deploy.yml` is a GitHub Actions workflow that runs automatically on every
release. It runs the tests, builds the application into a container image, publishes the image
to GitHub's container registry (ghcr.io), and instructs the server to pull the new image and
restart.

| | Runs | Does |
|---|---|---|
| `deploy.py` | once per machine, by a person | installs Docker, writes the configuration, starts the stack, registers the org, schedules backups |
| `.github/workflows/deploy.yml` | on every release, by GitHub | tests, builds the image, pushes it to ghcr.io, merges the repository's settings into the server's configuration, tells the server to pull and restart |

The interface between the two is deliberately small. Provisioning leaves a directory on the
server, `/opt/samskara`, containing `docker-compose.yml` and `.env`, and creates a user with
Docker access that the workflow can log in as. From then on the workflow owns `.env`: on every
deploy it merges the repository's variables and secrets into that file, replacing keys of the
same name and appending new ones. Only the generated signing secret (`JWT_SECRET`) and database
password (`POSTGRES_PASSWORD`) exist solely on the server.

## Contents

- [Prerequisites](#prerequisites)
- [Provisioning a machine](#provisioning-a-machine)
- [Configuration reference](#configuration-reference)
- [Behind a platform proxy](#behind-a-platform-proxy)
- [Connecting the workflow to the server](#connecting-the-workflow-to-the-server)

## Prerequisites

Have the following in place before provisioning.

1. **A virtual machine** running Ubuntu 22.04 or 24.04, with your SSH public key installed for
   root or for a user with sudo access. Most providers install the key when the machine is
   created. Provisioning logs in with that key. Nothing else needs to be installed on the
   machine.
2. **A domain name** with a DNS A record pointing at the machine. Provisioning installs Caddy, a
   web server that obtains an HTTPS certificate on first start, and certificate issuance fails
   if the domain does not yet resolve.
3. **A GitHub OAuth app** for the organisation. This is a registration that allows a website to
   authenticate users with their GitHub accounts. Its callback must be
   `https://DOMAIN/api/auth/github/callback`. Retain the client id and client secret.
4. **An AI reviewer credential.** The image ships both the Claude Code and opencode CLIs, and
   the server does not start without a credential for the reviewer in use. With
   `AI_REVIEW_HARNESS=claude`, that is `CLAUDE_CODE_OAUTH_TOKEN` (obtained by running
   `claude setup-token` on your machine) or `ANTHROPIC_API_KEY`. With
   `AI_REVIEW_HARNESS=opencode`, it is `OPENCODE_API_KEY`. Provisioning copies these
   variables, and any variable beginning `AI_REVIEW_`, from your shell to the server.
5. **A published container image.** Provisioning finishes by pulling the application image from
   ghcr.io, so the Deploy workflow must have published it at least once, and the `samskara`
   package under the organisation's Packages must be public. On a new fork, run the workflow
   manually with any tag: the deploy job fails because no server exists yet, but the build job
   publishes the image, which is sufficient at this stage.
6. **A deploy key pair.** This is the SSH key the workflow uses to log in to the server:
   ```sh
   ssh-keygen -t ed25519 -f ~/.ssh/samskara_deploy -N ""
   ```
   Provisioning installs the public half on the server. The private half is added to GitHub in
   [Connecting the workflow to the server](#connecting-the-workflow-to-the-server).

## Provisioning a machine

```sh
cd deploy
pip install -r requirements.txt

export DEPLOY_HOST=1.2.3.4 DOMAIN=samskara.example.org ORG_SLUG=example-org \
       GITHUB_CLIENT_ID=... GITHUB_CLIENT_SECRET=... \
       AI_REVIEW_HARNESS=claude CLAUDE_CODE_OAUTH_TOKEN=... \
       DEPLOY_PUBKEY=~/.ssh/samskara_deploy.pub

pyinfra inventory.py deploy.py --dry   # show what would change
pyinfra inventory.py deploy.py -y      # apply
```

The dry run connects to the machine, inspects its current state and lists every change it would
make, without making any. The apply run makes those changes. On completion, the site is served at
`https://DOMAIN`.

Provisioning is safe to repeat. `.env` is written only when absent, so the generated signing
secret and database password never change once set. Everything else is brought into line with
the files in this directory.

## Configuration reference

Configuration is passed as environment variables, read by `inventory.py`. If a required variable
is missing, provisioning stops and names it.

| Variable | Required | Meaning |
|---|---|---|
| `DEPLOY_HOST` | yes | IP address or hostname of the machine |
| `DOMAIN` | yes | public domain the application is served on |
| `ORG_SLUG` | yes | GitHub organisation to register. Only its members can sign in |
| `GITHUB_CLIENT_ID` | yes | from the OAuth app |
| `GITHUB_CLIENT_SECRET` | yes | from the OAuth app |
| `DEPLOY_PUBKEY` | yes | path to the public half of the deploy key |
| `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, `OPENCODE_API_KEY` | at least one | the AI reviewer's credential. Copied to the server as given; the server checks on start that the credential matches the chosen reviewer |
| `AI_REVIEW_HARNESS` | no | which reviewer to run: `opencode` (the server's default) or `claude`. Any other `AI_REVIEW_*` variable is copied to the server as well |
| `ADMIN_USER` | no | user that provisioning logs in as. Default `root` |
| `SUPER_ADMIN_LOGINS` | no | comma-separated GitHub usernames granted access to every project |
| `SAMSKARA_IMAGE` | no | container image to run. Default `ghcr.io/vertexcover-io/samskara`. A fork sets its own `ghcr.io/OWNER/REPO`, which is where its Deploy workflow publishes |
| `SAMSKARA_TAG` | no | image tag to start with. Default `latest`. Updated by every deploy |
| `PROXY` | no | `caddy` (default) installs Caddy to terminate HTTPS. `external` skips it, for platforms that already terminate HTTPS and forward to port 3000 |
| `APP_USER` | no | user the workflow deploys as. Default `samskara`, created by provisioning |
| `APP_BIND` | no | network interface the application listens on. Derived from `PROXY` |

All of these end up in a single file on the server, `/opt/samskara/.env`, readable only by the
deploy user.

## Behind a platform proxy

Some platforms, such as exe.dev, already terminate HTTPS and forward traffic to port 3000 on
the machine, and route SSH through their own proxy rather than the machine's `authorized_keys`.
Provisioning such a machine differs in three ways:

```sh
export PROXY=external APP_USER=exedev ADMIN_USER=exedev DEPLOY_HOST=NAME.exe.xyz DOMAIN=NAME.exe.xyz
```

- `PROXY=external` skips Caddy and the firewall and publishes the application on
  `0.0.0.0:3000`, which is where the platform forwards `https://NAME.exe.xyz/`. On exe.dev,
  `ssh exe.dev share show NAME` should report port 3000 in mode PUBLIC.
- `APP_USER=exedev` is required because the exe.dev SSH proxy ignores the username and always
  lands on `exedev`, so the workflow must deploy as that user. Set `DEPLOY_USER=exedev` in the
  `production` environment as well.
- The deploy key is registered with the platform account rather than on the machine, scoped
  to this VM by tag:
  ```sh
  ssh exe.dev tag NAME samskara-deploy
  ssh exe.dev ssh-key add --tag=samskara-deploy "$(cat ~/.ssh/samskara_deploy.pub)"
  ```
- `SSH_HOST_KEY` is the proxy's key, which is RSA: `ssh-keyscan -t rsa NAME.exe.xyz`.

## Connecting the workflow to the server

The workflow logs in to the server over SSH to deploy. Complete this step after provisioning,
because the server's host key is read from the running machine.

In the repository, create an environment named `production` and add the following:

| Kind | Name | Value |
|---|---|---|
| secret | `SSH_PRIVATE_KEY` | contents of `~/.ssh/samskara_deploy` |
| secret | `SSH_HOST_KEY` | one line from `ssh-keyscan -t ed25519 DEPLOY_HOST` |
| variable | `DEPLOY_HOST` | the machine's IP address or hostname |
| variable | `DOMAIN` | the public domain |
| variable | `DEPLOY_USER` | only when `APP_USER` was changed from its default |
| secret | `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, `OPENCODE_API_KEY` | optional. The AI reviewer's credential, if it should be managed from GitHub rather than set once at provisioning |

Every other variable in the environment is treated as application configuration and merged into
`/opt/samskara/.env` on each deploy. This is how a setting such as `LOG_LEVEL` or
`AI_REVIEW_HARNESS` is changed after provisioning: add or edit it in the `production`
environment and re-run Deploy with the current tag.

The equivalent from the command line, in a checkout of the repository and with `DEPLOY_HOST` and
`DOMAIN` still exported from provisioning:

```sh
gh api -X PUT "repos/{owner}/{repo}/environments/production"
gh secret set SSH_PRIVATE_KEY --env production < ~/.ssh/samskara_deploy
ssh-keyscan -t ed25519 "$DEPLOY_HOST" | gh secret set SSH_HOST_KEY --env production
gh variable set DEPLOY_HOST --env production --body "$DEPLOY_HOST"
gh variable set DOMAIN --env production --body "$DOMAIN"
```

Repository-level secrets and variables also work. The environment adds only the option of
requiring reviewer approval before each deployment.

If the image on ghcr.io was first pushed from a developer's machine rather than by the workflow,
GitHub requires a one-time grant before the workflow can update the package. In the package
settings, select **Manage Actions access** and add the repository with the Write role. A package
first pushed by the workflow has this grant already.

Finally, run the workflow once manually from **Actions, Deploy, Run workflow** with an existing
tag. All three jobs should pass. The final step requests `https://DOMAIN/api/health` and fails
if the site does not respond. Later releases deploy themselves, and the same manual run with an
older tag rolls back. The tag currently running is recorded as `SAMSKARA_TAG` in
`/opt/samskara/.env`. Backups of the database are taken nightly at 03:00 into
`/opt/samskara/backups`, with the last seven retained.
