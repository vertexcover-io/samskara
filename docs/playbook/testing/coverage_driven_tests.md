# Coverage-driven tests

Read the code, look at what the existing tests already exercise, and add
tests for the uncovered behavior that matters. This is the opposite
stance from [blind signature tests](blind_signature_tests.md): here the
writer sees everything, and the risk to manage is writing tautologies —
tests that restate the line they were written to cover and would pass
even if that line were wrong.

## The workflow

1. **Get the coverage picture.** Run the project's runner with coverage
   on, or, where no coverage tooling exists yet, build the picture by
   hand: list the public operations and branches, and map each existing
   test (from the registry, not by re-reading every test file) to what
   it exercises. The output either way is a list of behaviors nothing
   currently proves.

2. **Decide what matters; ignore the percentage.** For each uncovered
   behavior, ask what it costs a user if it silently breaks. Error
   paths, boundary branches, and anything that touches money, state
   machines, or locks rank high; getters, logging branches, and
   defensive code that can't be reached through the public surface rank
   low — and unreachable code is a finding to report, not to cover.
   The number going up is a side effect, never the goal.

3. **Add registry rows before code.** Each behavior you decided matters
   becomes a row with its `expected_behavior` in plain English. This is
   where the tautology defense starts: write the expected behavior from
   the contract — the DTO, the docstring, the flow doc — not by reading
   the branch and transcribing what it does. If you can only state the
   expectation by quoting the code, the row is `needs discussion`: the
   behavior has no source of truth yet.

4. **Write the tests through the normal flow.** Where the strategy doc
   says they belong, asserting through the surfaces it allows. Prefer
   asserting outcomes (the response, the persisted state, the emitted
   task) over internals, even when you can see the internals.

5. **Prove the delta.** Rerun coverage and confirm the branches you
   targeted are now exercised — a test that passes without touching its
   target branch is asserting something else. Then close the loop:
   rows to `implemented`, explorer rebuilt, and one line on what remains
   uncovered on purpose and why.

## When to use it

- After a feature settles: the blind pass covered the contract, this
  pass covers the branches the contract doesn't mention.
- Before a risky change to a module: cover the branches you're about to
  touch first, so the change lands against a net.
- Periodically per suite, as maintenance — but always through step 2;
  a coverage sweep that skips the "does it matter" question produces
  volume, not protection.

## What it costs

Coverage tooling setup once per repo, and discipline in step 3 — the
pull toward transcribing the code into assertions is constant, because
it always produces a green test. A green tautology is worse than no
test: it reports the behavior as proven.
