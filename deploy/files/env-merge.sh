#!/usr/bin/env bash
# Merge KEY=VALUE lines from stdin into a dotenv file, in place.
#
#   samskara-env-merge [FILE]        default FILE: /opt/samskara/.env
#   printf 'LOG_LEVEL=debug\n' | samskara-env-merge && docker compose up -d app
#
# A key that already has an assignment line is replaced on that line; a key the file lacks is
# appended. Comments, blank lines and every other key are left exactly as they were, which is
# the point: the file also holds generated secrets nothing else knows. The key match tolerates
# the same shapes as applyEnv in packages/server/src/scripts/env-file.ts (leading whitespace,
# spaces around `=`). The Deploy workflow pipes the repo's environment through this on every
# deploy. Provisioning (deploy/deploy.py) installs it beside the backup script.
set -euo pipefail

FILE="${1:-/opt/samskara/.env}"
NEXT="$(mktemp "$FILE.XXXXXX")"
trap 'rm -f "$NEXT"' EXIT

awk '
  function key(line,    k) {
    if (match(line, /^[ \t]*[A-Za-z_][A-Za-z0-9_]*[ \t]*=/) == 0) return ""
    k = substr(line, 1, RLENGTH - 1); gsub(/[ \t]/, "", k); return k
  }
  BEGIN {
    while ((getline line < "/dev/stdin") > 0) {
      k = key(line); if (k == "") continue
      if (!(k in ov)) order[n++] = k
      ov[k] = line
    }
  }
  { k = key($0); if (k != "" && (k in ov)) { print ov[k]; delete ov[k]; next } }
  { print }
  END { for (i = 0; i < n; i++) if (order[i] in ov) print ov[order[i]] }
' "$FILE" > "$NEXT"

chmod --reference="$FILE" "$NEXT"
mv -f "$NEXT" "$FILE"
trap - EXIT
