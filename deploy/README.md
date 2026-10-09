# Deploying Samskara to a VPS

Two pieces, run at different times:

| | Runs | Tool | Does |
|---|---|---|---|
| `deploy.py` | once per new machine, by a person | pyinfra over SSH | installs Docker and Caddy, writes config, starts the stack, registers the org |
| `.github/workflows/deploy.yml` | every release, by GitHub | Actions + SSH | tests, builds the image, pushes to ghcr.io, pulls and restarts on the server |

The contract between them is small: provisioning leaves `/opt/samskara` with
`docker-compose.yml`, `.env` and `.deploy.env`, and a `samskara` user in the `docker` group
that the workflow's key can log in as. The workflow touches nothing else.

## Before provisioning

1. A VPS running Ubuntu 22.04 or 24.04 with a public IP, reachable as root or a sudo user.
2. DNS: an A record for your domain pointing at that IP. Caddy fetches the TLS certificate
   on first start and fails without it.
3. A GitHub OAuth app for your org with callback `https://DOMAIN/api/auth/github/callback`.
   And a key for the AI reviewer: `OPENCODE_API_KEY`, or with `AI_REVIEW_HARNESS=claude` one of
   `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY`. The server will not boot without it.
4. A deploy key pair: `ssh-keygen -t ed25519 -f ~/.ssh/samskara_deploy -N ""`. The public
   half goes to provisioning, the private half to the workflow.
5. At least one release published by the Deploy workflow, so the image exists on ghcr.io,
   and the package set to public in the repo's Packages settings.

## Provision

```sh
cd deploy
pip install -r requirements.txt
export DEPLOY_HOST=1.2.3.4 DOMAIN=samskara.example.org ORG_SLUG=example-org \
       GITHUB_CLIENT_ID=... GITHUB_CLIENT_SECRET=... OPENCODE_API_KEY=... \
       DEPLOY_PUBKEY=~/.ssh/samskara_deploy.pub
pyinfra inventory.py deploy.py --dry    # plan
pyinfra inventory.py deploy.py -y       # apply
```

Rerunning is safe. `.env` and `.deploy.env` are written only when absent, so the generated
`JWT_SECRET` and database password never change. Everything else converges.

## Wire up the workflow

In the repo, create an environment named `production` and add:

| Kind | Name | Value |
|---|---|---|
| secret | `SSH_PRIVATE_KEY` | contents of `~/.ssh/samskara_deploy` |
| secret | `SSH_HOST_KEY` | one line from `ssh-keyscan -t ed25519 DEPLOY_HOST` |
| variable | `DEPLOY_HOST` | the VPS ip or hostname |
| variable | `DOMAIN` | the public domain |

Add required reviewers to the environment if a deploy should wait for approval.

## Day to day

- **Release**: `bun run release patch` publishes a release, which triggers Deploy.
- **Deploy a specific tag, or roll back**: Actions, Deploy, Run workflow, enter the tag.
- **See what is running**: `cat /opt/samskara/.deploy.env` on the server.
- **Change a setting**: edit `/opt/samskara/.env`, then
  `docker compose --env-file .env --env-file .deploy.env up -d app`.
- **Backups**: nightly at 03:00 into `/opt/samskara/backups`, last seven kept. Copying them
  off the machine is up to you.
