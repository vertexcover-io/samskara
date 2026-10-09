#!/usr/bin/env bash
# Nightly logical backup of the samskara database. Keeps the last 7.
set -euo pipefail

APP_DIR=/opt/samskara
OUT="$APP_DIR/backups/samskara-$(date +%F).sql.gz"

cd "$APP_DIR"
docker compose --env-file .env --env-file .deploy.env \
  exec -T db pg_dump -U samskara --no-owner samskara | gzip > "$OUT"

find "$APP_DIR/backups" -name 'samskara-*.sql.gz' -mtime +7 -delete
