"""
Provision a fresh Ubuntu VPS to run Samskara. Run once per machine; safe to run again.

Usage, from the deploy/ directory (templates are resolved relative to the cwd):

  pip install -r requirements.txt
  export DEPLOY_HOST=... DOMAIN=... ORG_SLUG=... GITHUB_CLIENT_ID=... \
         GITHUB_CLIENT_SECRET=... OPENCODE_API_KEY=... DEPLOY_PUBKEY=~/.ssh/samskara_deploy.pub
  pyinfra inventory.py deploy.py --dry     # show what would change
  pyinfra inventory.py deploy.py -y        # apply
"""

import secrets

from pyinfra import host
from pyinfra.facts.files import File
from pyinfra.facts.server import Which
from pyinfra.operations import apt, files, server, systemd

APP_DIR = "/opt/samskara"
APP_USER = "samskara"
COMPOSE = f"docker compose --env-file {APP_DIR}/.env --env-file {APP_DIR}/.deploy.env"
CADDY_KEYRING = "/usr/share/keyrings/caddy-stable-archive-keyring.gpg"

d = host.data

apt.packages(
    name="Base packages",
    packages=["ca-certificates", "curl", "gnupg", "ufw"],
    update=True,
    cache_time=3600,
)

if not host.get_fact(Which, command="docker"):
    server.shell(
        name="Install Docker",
        commands=["curl -fsSL https://get.docker.com | sh"],
    )

systemd.service(
    name="Docker enabled on boot",
    service="docker",
    running=True,
    enabled=True,
)

if not host.get_fact(File, path=CADDY_KEYRING):
    server.shell(
        name="Caddy signing key",
        commands=[
            "curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key"
            f" | gpg --dearmor -o {CADDY_KEYRING}",
        ],
    )

files.download(
    name="Caddy apt source",
    src="https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt",
    dest="/etc/apt/sources.list.d/caddy-stable.list",
)

apt.packages(
    name="Caddy",
    packages=["caddy"],
    update=True,
)

server.user(
    name="Service user",
    user=APP_USER,
    groups=["docker"],
    append=True,
    shell="/bin/bash",
    public_keys=[d.deploy_pubkey],
    ensure_home=True,
)

for path in (APP_DIR, f"{APP_DIR}/backups"):
    files.directory(
        name=f"Directory {path}",
        path=path,
        user=APP_USER,
        group=APP_USER,
        mode="750",
    )

if not host.get_fact(File, path=f"{APP_DIR}/.env"):
    files.template(
        name="Write .env (first run only)",
        src="templates/env.j2",
        dest=f"{APP_DIR}/.env",
        user=APP_USER,
        group=APP_USER,
        mode="600",
        domain=d.domain,
        client_id=d.client_id,
        client_secret=d.client_secret,
        super_admins=d.super_admins,
        review_harness=d.review_harness,
        review_keys=d.review_keys,
        jwt_secret=secrets.token_hex(32),
        pg_password=secrets.token_hex(24),
    )

if not host.get_fact(File, path=f"{APP_DIR}/.deploy.env"):
    files.template(
        name="Seed .deploy.env (first run only)",
        src="templates/deploy-env.j2",
        dest=f"{APP_DIR}/.deploy.env",
        user=APP_USER,
        group=APP_USER,
        mode="640",
        tag=d.tag,
    )

files.put(
    name="docker-compose.yml",
    src="files/docker-compose.yml",
    dest=f"{APP_DIR}/docker-compose.yml",
    user=APP_USER,
    group=APP_USER,
    mode="640",
)

files.template(
    name="Caddyfile",
    src="templates/Caddyfile.j2",
    dest="/etc/caddy/Caddyfile",
    mode="644",
    domain=d.domain,
)

systemd.service(
    name="Caddy running",
    service="caddy",
    running=True,
    enabled=True,
    reloaded=True,
)

server.shell(
    name="Firewall: allow ssh, http, https; enable",
    commands=[
        "ufw allow 22/tcp",
        "ufw allow 80/tcp",
        "ufw allow 443/tcp",
        "ufw --force enable",
    ],
)

files.put(
    name="Backup script",
    src="files/pg-backup.sh",
    dest="/usr/local/bin/samskara-pg-backup",
    mode="755",
)

for unit in ("samskara-pg-backup.service", "samskara-pg-backup.timer"):
    files.put(
        name=f"Backup {unit}",
        src=f"files/{unit}",
        dest=f"/etc/systemd/system/{unit}",
        mode="644",
    )

systemd.service(
    name="Nightly backup timer",
    service="samskara-pg-backup.timer",
    running=True,
    enabled=True,
    daemon_reload=True,
)

server.shell(
    name="Pull and start the stack",
    commands=[f"cd {APP_DIR} && {COMPOSE} pull && {COMPOSE} up -d --wait"],
)

server.shell(
    name=f"Register org {d.org_slug}",
    commands=[
        f"cd {APP_DIR} && {COMPOSE} run --rm --no-deps app"
        f" node packages/server/dist/scripts/seed-org.js {d.org_slug}",
    ],
)
