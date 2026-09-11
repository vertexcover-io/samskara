# Watchers — no background work runs unobserved

Part of the mission-control pattern: the orchestrating session's job
is deciding, reviewing, and keeping the shared picture current — and
it cannot do any of that about work it has stopped observing. A
background job without a watcher is a job whose failure gets
discovered late; a subagent without one can park itself or go in
circles for an hour before anyone notices. Both happened on
2026-08-23, which is where this page comes from.

## The pattern

Arm the watcher in the same breath as the run — one action, two
tool calls, never "I'll add it if it seems slow."

1. **Background jobs** (a suite run, a capture, a build): run the job
   writing to a log file, then start a Monitor running
   `scripts/watch-progress.sh <logfile>`. The script emits one line
   per milestone, a stall alarm when the log stops growing with no
   worker process alive, and the final verdict line, then exits.
   Tune the milestone regex and process pattern per job:

       scripts/watch-progress.sh out.log "capture:|CLEAN|DIRTY" pytest 3

2. **Subagents**: know each agent's expected duration the way you
   know a test's (see `docs/tests/testing_strategy.md`, the duration
   rule). Past about three times the expectation with no completion,
   check its visible footprint (files changed in the repo, processes
   it should be running) — a repo diff that stopped changing is the
   agent-shaped stall alarm. A stopped agent that reports "waiting
   for X" is stuck, not patient: agents cannot receive most
   notifications; resume it with the instruction to check directly.

3. **What a watcher event means**: a milestone line is progress —
   usually no action. A stall alarm means read the evidence now (the
   job's log, the run's state through the owned CLI), not wait
   another cycle. Silence from the watcher itself is not a verdict —
   the watcher can only vouch for what its filter matches, so its
   milestone regex must match every terminal state, failure included.

## Calibration

Expected durations for this repo's common jobs live in
`docs/tests/testing_strategy.md` (the "know the expected duration"
rule): a unit file in seconds, one mock verb test 10-30 seconds, the
full mock suite about 10 minutes, an audit capture about 15. A
watcher's stall threshold derives from those, not from patience.
