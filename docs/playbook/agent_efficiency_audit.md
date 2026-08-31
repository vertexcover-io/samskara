# Auditing an agent's run for efficiency

How to review a finished agent's transcript and turn its waste into
compounding assets. The output is not a grade — it is the list of
guides, scripts and doc fixes that make the next run fast.

## What to look for, in order of payoff

1. **Rediscovery.** Anything the agent worked out that the repo already
   documents (or should). Every rediscovery is a doc gap or a
   check-docs-first failure. Name the doc that should have been read, or
   the guide that should now exist (`docs/tests/guides/`).
2. **Repeated probing.** The same command or query run many times with
   small variations (polling by hand, re-grepping, re-reading files).
   Each cluster should become a script in `scripts/testing/` or a
   documented one-liner.
3. **Dead ends that were predictable.** Paths tried and abandoned that
   existing docs, tenets, or a 2-minute check would have ruled out.
   These usually mean a doc's title or index entry did not surface it.
4. **Missing tools.** Places the agent hand-assembled something (auth
   tokens, IDs, seeded records, status polling) that deserves a CLI
   path — tenet 7 — or a harness helper.
5. **Scope creep and over-building.** Work not needed for the goal.
6. **Waiting badly.** Sleeps and retries where a single wait-until
   check would do.

## The debugging rule this repo keeps re-learning

If a failure is deterministic, diagnose from state and files; a run loop
is only for proving the fix. And before any diagnosis: open
`docs/breadcrumb_analysis/_INDEX.md`, find the symptom in its table, and
quote the matching row back before doing anything else. Twice now an
agent burned 15+ minutes cycling a slow loop while the breadcrumb's
symptom table held the answer in one line (the AFM log paths; the
roles-need-a-tenant 403). A brief that involves debugging should make
"quote the symptom row" its literal first step, not a reading
suggestion.

## Method

Read the transcript (it is JSONL; read in chunks), tally tool calls by
kind, and mark each against the list above. Compare elapsed time and
token spend to what the task inherently needed. Be concrete: "calls
41-63 re-derive the login flow that tests/platform/_harness/api_client.py
already implements" beats "too many calls".

## Output

- A short findings list, ranked by time wasted, each with the fix.
- The concrete artifacts to create: which guides (topic + the facts that
  go in them), which scripts (name + what they do), which doc/index
  fixes so the knowledge is findable.
- One paragraph: what the *next* agent brief should say differently.

Per docs/tenets.md rule 5: anything the run tripped over three or more
times gets captured in docs as part of acting on the audit, not as a
suggestion.
