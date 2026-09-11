# The preflight ladder: never assume a layer you can check

Born from losing an hour to a test stack whose wiring was broken in three
places, discovered one 10-minute suite run at a time. The general
pattern: anything expensive (a suite, a deploy, a long agent run) stands
on layers that can each be checked in seconds. Check them, in order,
before spending anything.

## The rules

- **Cheap gates expensive.** Rungs run in cost order: environment, then
  stored state, then wiring, then one end-to-end probe, then the real
  work. A rung only runs when everything below it passed.
- **A failure names its rung.** The output of a failed check says what
  is wrong and where to fix it, in one line. "Ladder failed at rung 4:
  the service key in the preset is not registered in the test core DB"
  beats any amount of suite output.
- **Every silent skip becomes a rung.** A setup step that warns and
  continues on failure is a time bomb; the ladder is where its failure
  becomes loud. (The missing personal API key was a warn-and-skip for a
  day before the ladder made it a red line.)
- **The ladder is also the diagnosis.** When something breaks later,
  rerun the ladder — it points at the changed rung. Rungs are
  individually runnable for exactly this.
- **The expensive probe is one, not many.** One end-to-end run (a
  dummy_verb experiment, a smoke request, a canary) proves the pipeline;
  the suite proves behavior. Suites prove behavior, never wiring.

## Where it exists today

- The ladder itself is `tests/preflight/` — a pytest suite, one file per
  rung (`test_1_environment.py` .. `test_5_pipeline.py`), collection-ordered
  so `pytest -x` stops the climb at the first broken rung. A shared
  `conftest.py` resolves `OSS_TEST_STACK` (`test`, the default, or `dev`)
  once and hands every rung the same config — no test body hardcodes a
  port, DB name, or key. `OSS_PREFLIGHT_FAST=1` skips rung 5 (the one
  expensive probe). Every test has a plain-English docstring — the test
  dashboard reads it as the test's description (docs/tenets.md rule 3).
- The test stack: `scripts/test-stack.sh check [--fast]` runs
  `OSS_TEST_STACK=test pytest tests/preflight` (`--fast` sets
  `OSS_PREFLIGHT_FAST=1`). `up` runs the fast ladder automatically and dies
  if it's red; suites refuse to start without it. `test.sh`'s
  `platform --fresh` / `verbs --fresh` paths call `up`, so they inherit the
  same refusal.
- The dev stack: `scripts/verify.sh` is the same idea (its last rung is
  a real login) and now points at `OSS_TEST_STACK=dev pytest tests/preflight`
  as its final line for the rung-by-rung version of the same checks. It
  predates the pytest suite and should converge on it over time.

## When to build one

Whenever a failure costs minutes and its causes are checkable in
seconds. If you have twice diagnosed the same class of failure from an
expensive run's output, that is the signal: the third time is a rung.
