# Testing shortcuts: capture what you figure out

When you test something, look up a command, or work out how to do
something test-related, don't just do it — capture it, so the next time
is instant. Same idea as the breadcrumbs, applied to testing mechanics.

## Two outputs

- `docs/tests/guides/` — markdown guides organized by topic. Practical
  only: commands, paths, env setup, how to get test data, gotchas.
- `scripts/testing/` (repo root) — runnable scripts (sh/py) that
  automate tasks you did more than once.

## Process

1. **Check what exists first.** Look in `docs/tests/guides/` and
   `scripts/testing/` before figuring anything out from scratch. If a
   guide covers it, use it; if it is stale, fix it after the task.
2. **Do the task**, tracking what you discover: commands and why, paths
   that matter, how to get specific data (IDs, tokens, seeded records),
   environment requirements, and anything non-obvious that cost time.
3. **Write or update the guide.** Topic-based filename
   (`getting-test-ids.md`, `afm-verb-testing.md`). Format: Quick
   reference up top (the sticky-note version), then Setup, How to,
   Useful paths, Gotchas. Skip sections that don't apply. Voice per
   `tone_and_taste.md`.
4. **Write a script if the task had steps.** Self-contained, usage
   comment at top, handles the obvious failure modes (service down,
   missing env), descriptive name (`get_run_status.sh`,
   `mint_api_key.py`).
5. **Report one line per artifact**: guide created/updated, script
   created/updated or n/a.

## Why this exists

The map_surface_topography test build spent a long time rediscovering
things this repo already knew (how login works, where run state lives,
how the scheduler is kicked) and things it now knows that nobody wrote
down as reusable mechanics. Knowledge that lives only in a finished
agent's transcript is lost; a guide or script compounds.
