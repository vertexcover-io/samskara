"""
Inventory for deploy.py. One VPS, described by environment variables.

Required:
  DEPLOY_HOST           ip or hostname of the VPS
  DOMAIN                public domain Caddy will serve, with DNS already pointing at the host
  ORG_SLUG              GitHub org slug to register
  GITHUB_CLIENT_ID      from the org's GitHub OAuth app
  GITHUB_CLIENT_SECRET  from the same app
  DEPLOY_PUBKEY         path to the public key the Deploy workflow will log in with
                        (on exe.dev the proxy checks the account's keys instead, so also
                        `ssh exe.dev ssh-key add` it; see README)
  CLAUDE_CODE_OAUTH_TOKEN  a credential for the AI reviewer; any AI_REVIEW_* variable and any
                        *_API_KEY / *_OAUTH_TOKEN in the shell is written to .env verbatim and
                        the server validates the combination when it boots

Optional:
  PROXY                 caddy (default): install Caddy, serve DOMAIN with auto TLS, bind the
                        app to localhost. external: a platform proxy (e.g. exe.dev) already
                        terminates TLS for DOMAIN and forwards to port 3000; skip Caddy and
                        the firewall and bind the app on all interfaces
  APP_BIND              interface docker publishes port 3000 on. Default 127.0.0.1 behind
                        Caddy, 0.0.0.0 behind an external proxy; set the proxy-facing
                        address instead when the platform has a fixed one
  APP_USER              user the Deploy workflow logs in as (default: samskara, created).
                        On exe.dev the proxy always lands on exedev, so set it to that
  ADMIN_USER            user with sudo for provisioning (default: root)
  SUPER_ADMIN_LOGINS    comma-separated GitHub logins with access to every project
  SAMSKARA_TAG          image tag to start with (default: latest)
"""

import os
import re
import sys
from pathlib import Path

_REQUIRED = (
    "DEPLOY_HOST",
    "DOMAIN",
    "ORG_SLUG",
    "GITHUB_CLIENT_ID",
    "GITHUB_CLIENT_SECRET",
    "DEPLOY_PUBKEY",
)

_missing = [key for key in _REQUIRED if not os.environ.get(key)]
if _missing:
    sys.exit(f"inventory.py: missing environment variables: {', '.join(_missing)}")

# Passed through by shape rather than by a table of harness -> credential names: the server
# owns that table (packages/core/src/review/harness.ts) and refuses to boot on a bad
# combination, so the only check worth making here is the one that fails fast.
_REVIEW_ENV = re.compile(r"^(AI_REVIEW_.*|.*_API_KEY|.*_OAUTH_TOKEN)$")
review_env = {k: v for k, v in os.environ.items() if _REVIEW_ENV.fullmatch(k) and v}
if not any(not k.startswith("AI_REVIEW_") for k in review_env):
    sys.exit("inventory.py: the AI reviewer needs a credential, e.g. CLAUDE_CODE_OAUTH_TOKEN")

proxy = os.environ.get("PROXY", "caddy")
if proxy not in ("caddy", "external"):
    sys.exit("inventory.py: PROXY must be caddy or external")

org_slug = os.environ["ORG_SLUG"]
if not re.fullmatch(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?", org_slug):
    sys.exit(f"inventory.py: ORG_SLUG is not a valid GitHub org slug: {org_slug}")

pubkey_path = Path(os.environ["DEPLOY_PUBKEY"]).expanduser()
if not pubkey_path.is_file():
    sys.exit(f"inventory.py: DEPLOY_PUBKEY is not a file: {pubkey_path}")

_admin_user = os.environ.get("ADMIN_USER", "root")

vps = [
    (
        os.environ["DEPLOY_HOST"],
        {
            "ssh_user": _admin_user,
            "_sudo": _admin_user != "root",
            "domain": os.environ["DOMAIN"],
            "proxy": proxy,
            "app_bind": os.environ.get("APP_BIND", "127.0.0.1" if proxy == "caddy" else "0.0.0.0"),
            "app_user": os.environ.get("APP_USER", "samskara"),
            "org_slug": org_slug,
            "client_id": os.environ["GITHUB_CLIENT_ID"],
            "client_secret": os.environ["GITHUB_CLIENT_SECRET"],
            "deploy_pubkey": pubkey_path.read_text().strip(),
            "super_admins": os.environ.get("SUPER_ADMIN_LOGINS", ""),
            "tag": os.environ.get("SAMSKARA_TAG", "latest"),
            "review_env": review_env,
        },
    )
]
