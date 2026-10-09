#!/usr/bin/env bash
# Nightly logical backup of the samskara database. Keeps the last 7.
#
# Dumps to a temp file and renames it into place only after gzip verifies it, so a failed
# or interrupted run never leaves a truncated file under the dated name, and a same-day
# rerun never destroys an earlier good backup before its replacement exists.
set -euo pipefail

APP_DIR=/opt/samskara
BACKUPS="$APP_DIR/backups"
OUT="$BACKUPS/samskara-$(date +%F).sql.gz"
TMP="$(mktemp "$BACKUPS/.samskara-XXXXXX.sql.gz.part")"
trap 'rm -f "$TMP"' EXIT

cd "$APP_DIR"
docker compose --env-file .env --env-file .deploy.env \
  exec -T db pg_dump -U samskara --no-owner samskara | gzip > "$TMP"

gzip -t "$TMP"
mv -f "$TMP" "$OUT"
trap - EXIT

find "$BACKUPS" -name 'samskara-*.sql.gz' -mtime +7 -delete
