# Bootstrapping a project that has none of this

The workflows in this folder assume the project has a registry, a
strategy doc, an explorer, and a runner. This doc is the minimal working
shape of each, so a new project can create them in an hour instead of
reinventing them. Everything here is the smallest version that keeps the
workflows honest; grow each piece only when it pinches.

## Start by looking at what exists

Before creating anything, inventory the project: what test files exist,
in which toolchains, what runs them today, and whether any doc already
plays one of the four roles. Then adopt rather than replace:

- Existing tests stay where they are and keep passing. They get
  registry rows with `status=implemented` and their real file paths —
  backfilling the registry is how an existing suite joins this system.
  A test that no longer matches what it claims gets `needs change`, not
  a rewrite on the spot.
- An existing runner (a Makefile target, an npm script) becomes the
  runner; wrap it only to add what's missing (non-zero exit, recorded
  results).
- Some decisions belong to the project's owner, not to whoever is
  bootstrapping: how to split suites, what the evidence rule allows,
  whether any existing tests should move or be retired. Bring those as
  a short list of questions with a recommendation each, and wait for
  answers before acting on them. Everything else — adding the registry,
  backfilling rows, writing the strategy doc from what's observably
  true — needs no permission.

## The registry

One or more CSVs (one per area once a single file gets too long to read
in a sitting), with a README beside them stating the rules. Columns:

- `id` — stable short id (`AUTH-003`). Never reused, even after a row is
  deleted.
- `area` — what part of the system the row belongs to.
- `title` — one line, what the test is called.
- `expected_behavior` — full sentences: what the test does and what it
  proves. Written the way you'd describe it to the person next to you,
  because it becomes the test's docstring once implemented.
- `status` — one of five: **implemented** (the file exists, runs, and
  does what the row says), **planned** (the code supports it; nobody
  wrote the test), **needs change** (the test exists but no longer
  proves what the row says), **needs discussion** (a person must decide
  something first; the row states the question), **blocked** (can't be
  written until something outside it changes; the row names what).
- `test_file` — filled only when status is `implemented`, exact path
  (and `::test_name` where useful).
- `fix` — for the three non-green statuses, one sentence naming exactly
  what stands in the way. Empty otherwise.

Worth adding once rows are being analyzed against code: `assert_code`
(the assertion in one near-code line), `severity` and `complexity`
(each as `high`/`medium`/`low`, a colon, and the reason — never the
bare word).

Two rules make the registry mean something. A test is not real until its
row says `implemented` and names the file — everything else is a plan,
not a claim. And anyone may add a row without asking, but flipping one
to `implemented` is a claim the test exists and passes, so it happens in
the same change that adds the test.

## The strategy doc

One markdown file that always exists and answers, for this project:

- What suites there are, what each one proves, and who owns each.
- Where each kind of test lives in the tree, and in which toolchain.
- What a test is allowed to read and assert through — the evidence
  rule. Decide this early: tests that reach into internals (raw SQL,
  private state) rot fastest.
- How to run each suite, as a table of command / what it runs / what it
  needs running.
- Decisions already made, listed so they don't get re-litigated.

It moves with the code: a change to the test setup updates this doc in
the same change.

## The explorer

A generated page (or at minimum a script that prints to the terminal)
that reads the registry and the test files — not run results — and
shows every row with its status, grouped by area, with each implemented
test's docstring beside its row. Its job is to answer "what tests exist
and what's still only planned" without opening the CSVs. Rebuild it in
the same change that adds a test or a row. A first version is a small
script that joins CSV rows to test files and writes one HTML or text
page.

## The runner

One command per suite (a single `test.sh` with subcommands works well)
that exits non-zero on any failure and prints where the results went.
Two properties matter from day one: a fresh checkout can run it with
only documented setup, and each run's outcome is recorded somewhere
(even a JSON file per run in a history folder) so "when did this last
pass" has an answer. Reports and dashboards can come later and read
that history.
