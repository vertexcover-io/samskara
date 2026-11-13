---
signal: Use when a planning step or the adr skill is about to write a new file under docs/adr/
paths: ["docs/adr/**"]
tags: [adr, planning]
strength: default
---
# Ask the person before adding a new ADR

The people on this project have removed ADRs that were not needed, so a new `docs/adr/` file is
not written on the skill's gates alone. Ask the person whether it should exist. If they say no,
put the decision's reason in the docblock of the code it governs and in the PR body.

**Occurrences:**
- 2026-11-13 · fix-decisions plan: ADR 0006 was written, then dropped at plan approval; its reason moved to a docblock and the PR

**Stale when:** `docs/adr/` is removed, or the `adr` skill stops writing files on its own.
