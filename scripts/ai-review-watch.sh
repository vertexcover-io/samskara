#!/usr/bin/env bash
#
# ai-review-watch.sh — watch a live AI-review run, flag stuck/thrashing/done.
#
# Reads two log streams simultaneously:
#   1. The server log (default /tmp/samskara-server-fresh.log, override with -s)
#      — pipeline milestones (workspace_ready, harness_spawning, harness_first_byte,
#        harness_complete, xml_parsed, grounded, persisted, harness_failed).
#   2. The msb sandbox exec.log for the matching samskara-ai-review-* VM
#      — every agent tool call as JSON {t,s,d,id}; we summarize the agent's bash
#      commands and count repetitions.
#
# Exits non-zero if the run terminates in failure (harness_failed, xml_unparseable,
# ungrounded) or with no terminal milestone after STUCK_AFTER_SECONDS.
#
# Usage:
#   scripts/ai-review-watch.sh                      # auto-detect most recent run
#   scripts/ai-review-watch.sh -t 120               # custom stuck threshold (s)
#   scripts/ai-review-watch.sh -s /path/to/log.log  # custom server log path
#   scripts/ai-review-watch.sh --peek 30            # just dump the last 30 tool calls
#                                                  #   from the latest sandbox and exit
#
# The script works against whatever is already on disk; it does not start a review.
# Pair with `samskara review <id> --ai` running in another terminal.

set -u

SERVER_LOG="${SAMSKARA_SERVER_LOG:-/tmp/samskara-server-fresh.log}"
STUCK_AFTER_SECONDS=90
PEEK_LINES=0
PEEK_ONLY=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    -s) SERVER_LOG="$2"; shift 2 ;;
    -t) STUCK_AFTER_SECONDS="$2"; shift 2 ;;
    --peek) PEEK_LINES="$2"; PEEK_ONLY=1; shift 2 ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [[ ! -f "$SERVER_LOG" ]]; then
  echo "server log not found at $SERVER_LOG" >&2
  echo "(set SAMSKARA_SERVER_LOG or pass -s)" >&2
  exit 2
fi

# Find the msb sandbox dir for the most recent samskara-ai-review-* VM (by mtime of
# its log dir — survives workspace cleanup since the sandbox dir is on the host).
latest_sandbox_dir() {
  find "$HOME/.microsandbox/sandboxes" -maxdepth 1 -name 'samskara-ai-review-*' \
    -type d 2>/dev/null \
    | xargs -I {} stat -f '%m %N' {} 2>/dev/null \
    | sort -nr \
    | head -1 \
    | awk '{print $2}'
}

SANDBOX_DIR="$(latest_sandbox_dir)"
EXEC_LOG="$SANDBOX_DIR/logs/exec.log"

# Track line counts we've already processed.
server_offset=0
exec_offset=0
declare -A TOOL_CALL_COUNT=()
declare -A LAST_SEEN_MILESTONE=()
last_progress_at=$(date +%s)
last_terminal=""

color() { printf '\033[%sm%s\033[0m' "$1" "$2"; }

emit() { printf '[t+%4ds] %s\n' "$(( $(date +%s) - START ))" "$1"; }

START=$(date +%s)
emit "$(color '36' "watching") server=$SERVER_LOG sandbox=${SANDBOX_DIR:-NONE}"
if [[ "$PEEK_ONLY" -gt 0 ]]; then
  if [[ -z "$SANDBOX_DIR" || ! -f "$EXEC_LOG" ]]; then
    echo "no exec.log under any samskara-ai-review-* sandbox" >&2
    exit 1
  fi
  total=$(wc -l < "$EXEC_LOG" | tr -d ' ')
  echo "--- last $PEEK_LINES bash commands (of $total log lines) from $SANDBOX_DIR/logs/exec.log ---"
  # Bash prompts in the msb exec.log are JSON records whose `d` field STARTS with the
  # escape sequence for `$ ` (the rest of the field is the body of the same call). Match
  # the head of d so multi-line heredocs that *contain* `$ ` don't false-positive.
  if command -v jq >/dev/null 2>&1; then
    jq -r 'select(.s == "stderr" and (.d | startswith("\u001b[0m$ "))) | "\(.t)  \(.d | ltrimstr("\u001b[0m$ ") | gsub("\\n"; " | ") | .[0:200])"' "$EXEC_LOG" \
      | sed 's/\x1b\[[0-9;]*m//g' \
      | tail -n "$PEEK_LINES"
  else
    grep -F '"s":"stderr"' "$EXEC_LOG" \
      | grep -F '"d":"\u001b[0m$ ' \
      | tail -n "$PEEK_LINES"
  fi
  echo "--- end ---"
  exit 0
fi

# Drain new server-log lines and update milestone tracking.
drain_server() {
  local now; now=$(date +%s)
  local new
  new=$(tail -n +"$((server_offset + 1))" -c +1 "$SERVER_LOG" 2>/dev/null)
  [[ -z "$new" ]] && return
  server_offset=$((server_offset + $(printf '%s' "$new" | wc -l)))
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    local m
    m=$(printf '%s' "$line" | grep -oE 'milestone":"[a-z_]+"' | head -1 | sed 's/milestone":"//;s/"//')
    if [[ -n "$m" ]]; then
      local prev="${LAST_SEEN_MILESTONE[name]:-}"
      LAST_SEEN_MILESTONE[name]="$m"
      LAST_SEEN_MILESTONE[at]="$now"
      last_progress_at="$now"
      local since; since=$((now - ${LAST_SEEN_MILESTONE[prev_at]:-$START}))
      emit "$(color '32' "milestone") $m (${since}s since $prev)"
      if [[ "$m" == "persisted" ]]; then
        last_terminal="persisted"; emit "$(color '32;1' "DONE") persisted"
      elif [[ "$m" == "harness_failed" || "$m" == "xml_unparseable" || "$m" == "ungrounded" ]]; then
        last_terminal="$m"; emit "$(color '31;1' "FAILED") $m"
      fi
    fi
    local fb
    fb=$(printf '%s' "$line" | grep -oE '"firstByteMs":[0-9]+' | head -1 | sed 's/"firstByteMs"://')
    if [[ -n "$fb" ]]; then
      emit "$(color '33' "first byte") after ${fb}ms — harness now has a stream"
      last_progress_at="$now"
    fi
  done <<< "$new"
}

# Drain new exec.log lines; count bash tool calls; flag over-probing.
drain_exec() {
  [[ ! -f "$EXEC_LOG" ]] && return
  local now; now=$(date +%s)
  local new
  new=$(tail -c +"$((exec_offset + 1))" "$EXEC_LOG" 2>/dev/null)
  [[ -z "$new" ]] && return
  exec_offset=$(wc -c < "$EXEC_LOG")
  # Each stderr line with a $ prompt is a bash call. Extract its first line and
  # normalize to a "signature" — the command up to 80 chars, whitespace squashed.
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    [[ "$line" != *'"s":"stderr"'* ]] && continue
    local sig
    sig=$(printf '%s' "$line" | grep -oE '"d":"\\\$ [^"]{1,160}' | head -1 | \
      sed 's/^"d":"\\\$ //;s/\\n.*$//;s/  */ /g' | head -c 80)
    [[ -z "$sig" ]] && continue
    last_progress_at="$now"
    TOOL_CALL_COUNT[$sig]=$(( ${TOOL_CALL_COUNT[$sig]:-0} + 1 ))
    local count=${TOOL_CALL_COUNT[$sig]}
    local tag="tool"
    [[ "$count" -gt 3 ]] && tag="$(color '31' "REPEAT($count)")"
    emit "$tag $sig"
  done <<< "$new"
}

# Periodic checks: stuck and over-probing.
check_health() {
  local now; now=$(date +%s)
  local idle=$(( now - last_progress_at ))
  # 1. Pre-first-byte stall: warn if harness_spawning was last milestone and no first_byte.
  local last_m="${LAST_SEEN_MILESTONE[name]:-}"
  if [[ "$last_m" == "harness_spawning" && $idle -gt $STUCK_AFTER_SECONDS ]]; then
    emit "$(color '31;1' "STUCK") no first_byte for ${idle}s (harness hasn't produced stdout)"
    emit "$(color '33' "hint") bash scripts/ai-review-peek.sh --peek 30 — what is the agent doing?"
    last_progress_at=$now   # don't spam
  fi
  # 2. Same tool call spammed: any single signature > 5x is wasteful.
  for sig in "${!TOOL_CALL_COUNT[@]}"; do
    local n=${TOOL_CALL_COUNT[$sig]}
    if [[ $n -gt 5 ]]; then
      emit "$(color '31;1' "THRASHING") same tool called ${n}x: $sig"
      last_progress_at=$now
    fi
  done
}

main_loop() {
  while :; do
    drain_server
    drain_exec
    [[ -n "$last_terminal" ]] && break
    check_health
    sleep 2
  done
}
trap 'emit "$(color '33' "interrupted")"' INT TERM
main_loop

# Final summary
emit "summary: server_offset=$server_offset exec_offset=$exec_offset milestone=${LAST_SEEN_MILESTONE[name]:-}"
case "$last_terminal" in
  persisted) exit 0 ;;
  harness_failed|xml_unparseable|ungrounded) exit 1 ;;
  *) exit 3 ;;
esac
