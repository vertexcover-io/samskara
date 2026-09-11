# Blind signature tests

Write tests from the public surface only — signatures, types, DTOs,
docstrings, API contracts — with the implementation never opened. A test
written while reading the implementation tends to assert what the code
does; a test written blind asserts what the code promised, so it can
catch the code doing the wrong thing confidently.

The whole workflow depends on one hard rule: **the test writer never
sees the implementation.** Not "tries not to" — the writer's only input
is a signature document, and someone else (or an earlier, separate pass)
produces that document. If the same agent extracts signatures and then
writes tests in one session, the implementation is in its context and
the blindness is gone.

## The workflow

1. **Find or generate the signature document.** Check whether the
   surface under test already has a contract doc: an API spec, a typed
   SDK interface, a DTO with validation rules, a flow doc. If nothing
   exists, run a separate extraction pass first: a mechanical agent
   reads the code and writes a document containing only the public
   surface — function and method signatures, parameter types and
   defaults, DTO fields and their validators, return shapes, thrown
   error types, and any docstrings. No bodies, no private helpers, no
   "how it works". Save that document next to the project's other test
   docs so it outlives this run.

2. **Brainstorm behaviors into the registry.** From the signature doc
   alone, write registry rows: for each operation, what a valid call
   should produce, what each constraint should reject, what the edge
   values at each boundary should do, what errors the signature admits.
   Ambiguity in the doc is a finding in itself — a parameter whose valid
   range you can't state from the signature gets a `needs discussion`
   row, not a guess.

3. **Write the tests from the rows.** Still only the signature doc and
   the registry rows as input. Use the project's harness the way its
   strategy doc says; the docstring is the row's `expected_behavior`.

4. **Run, then triage every failure as one of two things.** Either the
   expectation was wrong — the signature doc was ambiguous or you
   misread it; fix the doc so the ambiguity is gone, then the test — or
   the code is wrong, in which case you file the bug and leave the test
   red (or mark the row `blocked` naming the defect). What you never do
   is open the implementation and adjust the test until it passes:
   that converts a blind test into an implementation-aware one and
   throws away the reason this workflow exists.

5. **Close the loop.** Update rows to `implemented`, rebuild the
   explorer, and leave the signature document in place — the next blind
   pass starts from it instead of re-extracting.

## When to use it

- A new surface lands (a new verb, endpoint, SDK method): write the
  blind tests before or in parallel with the implementation.
- An existing surface has tests that were all written by people who knew
  the code: a blind pass over its signatures finds the assumptions those
  tests inherited.
- A refactor is planned: blind tests written beforehand are the ones
  that survive it meaningfully.

## What it costs

Extraction is an extra pass, and some failures will be misread
signatures rather than bugs. That's the trade: you pay triage time to
get tests whose expectations came from the contract instead of the code.
