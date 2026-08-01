---
title: "os.tmpdir() resolves to /tmp under turbo, breaking isCapturable-based fixtures"
date: 2026-08-01
category: gotchas
tags: [tmpdir, turbo, containment, vitest, macos, fixtures]
component: packages/cli/src/watcher/containment.ts
severity: medium
status: implemented
applies_to: ["packages/cli/src/watcher/*.test.ts", "packages/cli/src/watcher/containment.ts"]
stage: [code]
evidence_count: 1
last_validated: 2026-08-01
source: hard-won-success@transitive-reference-closure
related: ["packages/cli/src/watcher/containment.ts", "packages/cli/src/watcher/artifact-worker.test.ts"]
---

# os.tmpdir() resolves to /tmp under turbo, breaking isCapturable-based fixtures

## Problem

A test using `mkdtemp(join(tmpdir(), ...))` as a stand-in project root passed under a
direct `bun x vitest run`, then failed every assertion once run through `bun run test`
(turbo). `isCapturable()` silently rejected every file under the fixture root — no
error, just an empty result set where files were expected.

## Insight

**`os.tmpdir()` is environment-dependent, and turbo's task runner does not forward
`$TMPDIR` from the interactive shell the way a direct CLI invocation does.** Under
`bun run test`, `tmpdir()` falls back to the bare `/tmp`; under `bun x vitest run` in
an interactive shell, it resolves to the real per-user temp dir (`/var/folders/...` on
macOS). `containment.ts` hardcodes `/tmp` and `/private/tmp` as always-excluded roots
in `isCapturable` (independent of the project root check), so any fixture built under
`tmpdir()` is a coin flip depending on which command produced it.

## Solution

```ts
// file: packages/cli/src/watcher/artifact-worker.test.ts
const scratchRoot = (): string =>
  ["/tmp", "/private/tmp"].includes(tmpdir()) ? "/var/tmp" : tmpdir()
```

Use `scratchRoot()` (or an equivalent explicit fallback) instead of `tmpdir()` directly
whenever the fixture will be checked against `isCapturable` or anything that inherits
its exclusion rules.

## Prevention / Reuse

- Never call `mkdtemp(join(tmpdir(), ...))` directly in a test that exercises
  containment/capture logic — always route through a helper that falls back off
  `/tmp` and `/private/tmp`.
- If a containment-adjacent test passes under `vitest run` directly but fails under
  the project's aggregate `test`/turbo command, suspect `$TMPDIR` inheritance before
  suspecting test order or caching.
- `/var/tmp` is a safe substitute on macOS/Linux — it is real scratch space outside
  both excluded roots.

## Related

- `packages/cli/src/watcher/containment.ts` — `alwaysExcluded()` hardcodes `/tmp` and
  `/private/tmp`.
