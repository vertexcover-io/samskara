---
title: "Testing realpath-sensitive code and try/catch guards needs matching rigor, not just a passing assertion"
date: 2026-08-01
category: gotchas
tags: [vitest, realpath, macos, symlink, mutation-testing, try-catch, tautological-test]
component: packages/cli/src/watcher/artifact-worker.test.ts
severity: medium
status: implemented
applies_to: ["packages/cli/src/watcher/*.test.ts"]
stage: [review]
evidence_count: 2
last_validated: 2026-08-01
source: review-fix@transitive-reference-closure
related: ["packages/cli/src/watcher/artifact-worker.ts"]
---

# Testing realpath-sensitive code and try/catch guards needs matching rigor, not just a passing assertion

## Problem

Two separate review findings against the same test file, both about a test that
*looked* correct but wasn't proving what it claimed:

1. Once production code started realpath-ing paths before a containment check, every
   containment assertion in the suite started failing — not because the code was
   wrong, but because the test fixture's own `mkdtemp()` path was never realpath'd.
   On macOS, `/var` is itself a symlink to `/private/var`, so a raw fixture path never
   equals the realpath'd candidate the code now produces.
2. A regression test for `enqueueReferences`'s try/catch guard (which exists to
   guarantee a thrown scan error never turns an already-succeeded upload into a retry)
   asserted only that the referencing document's own upload succeeded and the queue
   ended empty. Both of those are already true *before* the guarded code runs —
   `settle()` and `advanceArtifactState()` execute before `enqueueReferences` is even
   called — so the test passed whether or not the catch was local. Deleting the
   try/catch (a mutation check) left it passing unchanged. Note this cuts both ways:
   the *first* version of this test — asserting only with a throwing `runGit` fake and
   no second entry — passed on its very first run, which correctly confirmed the guard
   itself already worked. The guard was never broken; only its proof was weak, and
   that weakness was invisible until someone tried to break it on purpose.

## Insight

**A test for realpath-sensitive or guard-wrapped code must be built with the same
rigor as the code it tests, and checked by deleting the thing it claims to prove.**
Two independent disciplines, easy to skip separately:

- If the code under test resolves symlinks before comparing paths, the test fixture
  and every expected value it compares against must be resolved the same way — a
  mismatch produces false failures (or, worse, false passes if both sides happen to
  agree by accident).
- A regression test for a `try`/`catch` guard must assert something that is **only**
  true if the catch stayed local — not something that was already going to be true
  regardless, because it happened earlier in the same function. The only reliable way
  to know is to delete the guard and confirm the test fails.

## Solution

```ts
// file: packages/cli/src/watcher/artifact-worker.test.ts
// Realpath the fixture root once, up front, everywhere the production code will
// realpath its own inputs before comparing.
dir = await realpath(await mkdtemp(join(scratchRoot(), "artifact-worker-")))
```

```ts
// A weak assertion: true whether or not the catch was local, because settle() and
// advanceArtifactState() for THIS entry already ran before enqueueReferences.
expect(sink.sent.map((p) => p.path)).toContain(firstPath)

// Strengthened: a second, independent due entry that can only be reached if the
// worker's drain loop survived the throw and kept claiming work.
expect(sink.sent.map((p) => p.path).sort()).toEqual([firstPath, secondPath].sort())
```

## Prevention / Reuse

- When production code adds a `realpath()` call before a comparison, grep every test
  fixture that feeds that comparison and realpath the fixture the same way — do this
  in the same commit, not as an afterthought when tests start failing.
- For any test whose stated purpose is "this guard protects X", ask: is the assertion
  true even with the guard removed? If unsure, delete the guard locally, run the test,
  confirm it fails, then restore it. A test that survives its own guard's removal is
  proving nothing.
- A guard around side-effecting code (settle/state writes that happen *before* the
  guarded call) needs an assertion that can only be satisfied by work done *after* the
  guard — e.g. a second independent unit of work that only completes if execution
  continued past the point being guarded.

## Related

- `packages/cli/src/watcher/artifact-worker.ts` — `enqueueReferences`'s try/catch and
  `capturableReferences`'s realpath-before-compare pattern, both under test here.
