#!/usr/bin/env bash
# Samskara's Postgres without Docker: a dedicated local cluster on port 5433 that matches
# .env.example's DATABASE_URL exactly. Uses the Homebrew PostgreSQL binaries if present.
#
#   scripts/local-pg.sh start     # create the cluster on first run, then start it
#   scripts/local-pg.sh stop      # shut it down (clean)
#   scripts/local-pg.sh status    # is it running?
#   scripts/local-pg.sh recreate  # DESTROY and re-create the cluster, then migrate+seed
#
# Port 5433 is the same port docker-compose maps, so only one of the two can run at a time.
# Stop whichever you are not using: `scripts/local-pg.sh stop` or `bun run stack:down`.

set -euo pipefail

PG_PORT=5433
PG_DATABASE_URL="postgres://samskara:samskara@localhost:${PG_PORT}/samskara"

if [ -x /usr/local/opt/postgresql@14/bin/pg_ctl ]; then
  PG_BIN=/usr/local/opt/postgresql@14/bin
elif [ -x /opt/homebrew/opt/postgresql@14/bin/pg_ctl ]; then
  PG_BIN=/opt/homebrew/opt/postgresql@14/bin
elif [ -x /opt/homebrew/opt/postgresql@16/bin/pg_ctl ]; then
  PG_BIN=/opt/homebrew/opt/postgresql@16/bin
elif [ -x /opt/homebrew/opt/postgresql@17/bin/pg_ctl ]; then
  PG_BIN=/opt/homebrew/opt/postgresql@17/bin
else
  echo "No Homebrew PostgreSQL found. Install one: brew install postgresql@16" >&2
  exit 1
fi

PG_DATA="${HOME}/.local/share/samskara-server/pg"
PG_LOG="${HOME}/.local/share/samskara-server/pg.log"
export PATH="$PG_BIN:$PATH"

ensure_cluster() {
  if [ ! -f "$PG_DATA/PG_VERSION" ]; then
    mkdir -p "$(dirname "$PG_DATA")"
    initdb -D "$PG_DATA" -U postgres --encoding=UTF8
  fi
}

is_running() {
  pg_ctl -D "$PG_DATA" status >/dev/null 2>&1
}

cmd_start() {
  ensure_cluster
  if is_running; then
    echo "already running on port ${PG_PORT} (pid $(pg_ctl -D "$PG_DATA" status | grep -o '[0-9]*' | head -1))"
    return
  fi
  pg_ctl -D "$PG_DATA" -o "-p ${PG_PORT} -k /tmp" -l "$PG_LOG" start
  # Role and database exist before the first migrate; safe to re-run.
  psql -h localhost -p "$PG_PORT" -U postgres -d postgres -tc \
    "SELECT 1 FROM pg_roles WHERE rolname='samskara'" | grep -q 1 ||
    psql -h localhost -p "$PG_PORT" -U postgres -d postgres -c \
      "CREATE ROLE samskara LOGIN PASSWORD 'samskara' CREATEDB;"
  psql -h localhost -p "$PG_PORT" -U postgres -d postgres -tc \
    "SELECT 1 FROM pg_database WHERE datname='samskara'" | grep -q 1 ||
    psql -h localhost -p "$PG_PORT" -U postgres -d postgres -c \
      "CREATE DATABASE samskara OWNER samskara;"
  echo "database url: ${PG_DATABASE_URL}"
}

cmd_stop() {
  pg_ctl -D "$PG_DATA" stop || true
  echo "stopped"
}

cmd_status() {
  if is_running; then
    echo "running on port ${PG_PORT}"
    psql "$PG_DATABASE_URL" -tc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'" | xargs echo "public tables:"
  else
    echo "not running"
    exit 1
  fi
}

cmd_recreate() {
  if is_running; then cmd_stop; fi
  rm -rf "$PG_DATA" "$PG_LOG"
  cmd_start
  (cd "$(dirname "$0")/.." && DATABASE_URL="$PG_DATABASE_URL" bun run db:migrate)
  echo "recreated and migrated. seed with: DATABASE_URL=$PG_DATABASE_URL bun run seed --if-empty"
}

case "${1:-}" in
  start) cmd_start ;;
  stop) cmd_stop ;;
  status) cmd_status ;;
  recreate) cmd_recreate ;;
  *)
    echo "usage: scripts/local-pg.sh {start|stop|status|recreate}" >&2
    exit 1
    ;;
esac
