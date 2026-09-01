#!/usr/bin/env bash
set -euo pipefail

# Query the deployed samskara server.
#
# Everything server-side runs as the app user through passwordless `sudo -u`,
# and DATABASE_URL is sourced from the server's own .env. The connection string
# is never passed on a command line, never printed, and never leaves the server.
#
#   prod.sh -u ritesh -H refrensaitracker.io version
#   prod.sh -u ritesh -H refrensaitracker.io sql 'select count(*) from sessions'
#   prod.sh -u ritesh -H refrensaitracker.io sql -f query.sql
#   prod.sh -u ritesh -H refrensaitracker.io sql --write 'update ...'

SSH_HOST="${SAMSKARA_SSH_HOST:-}"
SSH_USER="${SAMSKARA_SSH_USER:-}"
APP_USER="${SAMSKARA_APP_USER:-refrensaitracker}"
APP_DIR="${SAMSKARA_APP_DIR:-/home/refrensaitracker/htdocs/refrensaitracker.io}"
PM2_NAME="${SAMSKARA_PM2_NAME:-samskara-api}"
WRITE=0
SQL=""
SQL_FILE=""
CMD=""

die() { printf '\nerror: %s\n' "$*" >&2; exit 1; }

usage() {
  cat >&2 <<'USAGE'
usage: prod.sh -u SSH_USER -H HOST <command>

commands:
  version              deployed package version and pm2 status
  sql 'QUERY'          run SQL in a READ ONLY transaction; Postgres rejects any write
  sql --write 'QUERY'  run SQL in a normal transaction; any error rolls the whole thing back
  sql -f FILE          read the query from a local file instead of an argument

options:
  --app-user USER      server user that owns the app (default: refrensaitracker)
  --dir PATH           app directory on the server
USAGE
  exit 1
}

[[ $# -gt 0 ]] || usage
while [[ $# -gt 0 ]]; do
  case "$1" in
    -u|--user) [[ $# -ge 2 ]] || die "$1 needs a value"; SSH_USER="$2"; shift ;;
    --user=*) SSH_USER="${1#*=}" ;;
    -H|--host) [[ $# -ge 2 ]] || die "$1 needs a value"; SSH_HOST="$2"; shift ;;
    --host=*) SSH_HOST="${1#*=}" ;;
    --app-user) [[ $# -ge 2 ]] || die "$1 needs a value"; APP_USER="$2"; shift ;;
    --dir) [[ $# -ge 2 ]] || die "$1 needs a value"; APP_DIR="$2"; shift ;;
    -f|--file) [[ $# -ge 2 ]] || die "$1 needs a value"; SQL_FILE="$2"; shift ;;
    --write) WRITE=1 ;;
    -h|--help) usage ;;
    -*) die "unknown flag: $1" ;;
    version|sql) CMD="$1" ;;
    *) SQL="$1" ;;
  esac
  shift
done

[[ -n "$SSH_USER" ]] || { printf '\nerror: -u SSH_USER is required\n' >&2; usage; }
[[ -n "$SSH_HOST" ]] || { printf '\nerror: -H HOST is required\n' >&2; usage; }
[[ -n "$CMD" ]] || { printf '\nerror: no command given (version or sql)\n' >&2; usage; }
SSH_TARGET="${SSH_USER}@${SSH_HOST}"

# bun, node and pm2 live in the app user's home, not on a shared PATH.
NODE_PATH_FIX="for d in /home/$APP_USER/.nvm/versions/node/*/bin; do PATH=\$d:\$PATH; done; export PATH"

if [[ "$CMD" == version ]]; then
  ssh -o ConnectTimeout=10 "$SSH_TARGET" \
    "sudo -n -u '$APP_USER' bash -c 'cd \"$APP_DIR\" && export PM2_HOME=/home/$APP_USER/.pm2 && $NODE_PATH_FIX && grep -m1 version package.json && pm2 list'"
  exit 0
fi

if [[ -n "$SQL_FILE" ]]; then
  [[ -f "$SQL_FILE" ]] || die "no such file: $SQL_FILE"
  SQL="$(cat "$SQL_FILE")"
fi
[[ -n "$SQL" ]] || die "no SQL given"

# Right-trim, then guarantee a terminator: without one the appended `commit`
# is parsed as part of the last statement rather than as its own.
SQL="${SQL%"${SQL##*[![:space:]]}"}"
[[ "$SQL" == *";" ]] || SQL="$SQL;"

# Read-only is enforced by Postgres, not by pattern-matching the query text:
# `set transaction read only` rejects INSERT/UPDATE/DELETE/DDL outright, so a
# write that slips through a text check still cannot land.
if [[ $WRITE -eq 1 ]]; then
  PREAMBLE="begin;"
  printf '\n\033[1;33m-- WRITE MODE: this can modify production data --\033[0m\n' >&2
else
  PREAMBLE=$'begin;\nset transaction read only;'
fi

# The query travels over stdin, so nothing in it is reinterpreted by a shell.
printf '%s\n%s\ncommit;\n' "$PREAMBLE" "$SQL" \
  | ssh -o ConnectTimeout=10 "$SSH_TARGET" \
      "sudo -n -u '$APP_USER' bash -c 'cd \"$APP_DIR\" && set -a && . ./.env && set +a && exec psql \"\$DATABASE_URL\" -v ON_ERROR_STOP=1 -f -'"
