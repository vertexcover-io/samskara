---
title: "A new containment-check call site must realpath before isCapturable, or a symlink escapes it"
date: 2026-08-01
category: gotchas
tags: [symlink, containment, security, realpath, toctou]
component: packages/cli/src/watcher/artifact-worker.ts
severity: high
status: implemented
applies_to: ["packages/cli/src/watcher/*.ts"]
stage: [review]
evidence_count: 1
last_validated: 2026-08-01
source: review-fix@transitive-reference-closure
related: ["packages/cli/src/watcher/containment.ts", "packages/cli/src/watcher/driver.ts"]
---

# A new containment-check call site must realpath before isCapturable, or a symlink escapes it

## Problem

A new call site (`capturableReferences` in `artifact-worker.ts`) ran `isCapturable()`
directly on the lexically-resolved reference path, without ever calling `realpath`
first — unlike the pre-existing write-tool-call path in `driver.ts`, which does
realpath before its containment check. A symlink sitting inside the project root but
pointing outside it (e.g. into `~/.ssh`) passed containment on its *own* path, then
got read and uploaded to the remote sink carrying its true target's bytes. Three
independent review personas (security, code-quality, spec) flagged the same gap
independently.

## Insight

**`isCapturable()` is a lexical, string-based check — it has no idea a path is a
symlink, and judges only the path you hand it.** Every new call site that hands it a
path derived from something other than a direct write (i.e. anything that could be a
symlink: a reference discovered by scanning content, a path read from a directory
listing) must resolve symlinks *before* the check, exactly as the codebase's existing
call site (`driver.ts`) already does. Copying the pattern from a sibling call site is
not optional here — containment logic that isn't mirrored consistently is a security
bug, not a style inconsistency.

## Solution

```ts
// file: packages/cli/src/watcher/artifact-worker.ts
const realCapturablePath = async (ref: string, projectRoot: string): Promise<string | null> => {
  const resolved = await realpath(ref).catch(() => ref)
  const info = await stat(resolved).catch(() => null)
  if (!info?.isFile()) return null
  if (!isCapturable(resolved, projectRoot)) return null
  return resolved
}
```

Both sides of the comparison must be resolved consistently — the candidate path *and*
the project root it's compared against (macOS's `/var` → `/private/var` symlink means
an un-resolved root rejects every in-root reference once the candidate side is
resolved).

## Prevention / Reuse

- Before adding any new place that calls `isCapturable` (or a similar
  containment/allow-list check), grep for existing call sites first and match their
  realpath discipline exactly — don't re-derive it.
- When a path enters the containment check from anything other than a literal,
  directly-supplied file path (scanned content, directory listing, glob), treat it as
  symlink-suspect by default.
- realpath both operands of a containment comparison, not just one — a mismatched
  resolution state on either side produces either a bypass or a false rejection.

## Related

- `packages/cli/src/watcher/containment.ts` — the lexical `isCapturable()` check.
- `packages/cli/src/watcher/driver.ts` — the pre-existing call site whose realpath
  discipline this new one needed to mirror.
