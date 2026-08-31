# The testing playbook

This folder holds the test-writing workflows themselves — the process an
agent or a person follows to produce tests. It contains nothing about
any one project: no repo paths, no suite names, no harness details. That
is what lets these workflows travel: to use them in a repo, copy this
folder and write a thin skill that binds it to that repo (see below).

## What every workflow expects the project to have

The workflows refer to four things by name. Each project provides its
own version of them, and the project's skill says where they are:

- **The registry** — where a test starts as a plain-English row of what
  it should prove, before any code exists.
- **The strategy doc** — where tests live, what suites there are, and
  what surfaces a test may read and assert through.
- **The explorer** — the page listing every planned and implemented
  test, rebuilt in the same change that adds one.
- **The runner** — the one command that runs a suite and records the
  result.

A project that doesn't have one of these creates it before the first
workflow run. [bootstrap.md](bootstrap.md) describes the minimal working
shape of each — and how to adopt tests a project already has (inventory
first, backfill the registry, and bring the owner the decisions that
are theirs) rather than replace them.

## The workflows

- [blind_signature_tests.md](blind_signature_tests.md) — write tests
  from signatures only, never seeing the implementation. Catches "the
  code does the wrong thing" bugs that implementation-aware tests pin in
  place.
- [coverage_driven_tests.md](coverage_driven_tests.md) — read the code
  and its coverage, decide which uncovered behavior matters, and add
  tests for it through the normal registry flow.
- [patterns.md](patterns.md) — other test-writing patterns worth
  reaching for, with when each one earns its cost.
- [../testing_shortcuts.md](../testing_shortcuts.md) — not a way of
  writing tests, but the companion habit: capture the commands and
  gotchas you discover while testing so the next run is instant.

## Binding this folder to a project

The entry point in each repo is a skill (in this repo: `/write-tests`).
The skill is deliberately the only project-specific piece: it routes
`--from signatures` / `--from coverage` to the two workflow docs, asks
which if unspecified, and names where that repo keeps its registry,
strategy doc, explorer, and runner — or points at
[bootstrap.md](bootstrap.md) when the repo has none yet. Porting to a
new project means copying this folder unchanged and writing that one
skill file.
