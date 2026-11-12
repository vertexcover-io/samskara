---
status: inactive
date: 2026-11-11
source: yok run review-worker (task text and design.md)
tags: [session-reviews, ai-review]
---

# A review's state lives on its sessionReviews row, and any row with a result counts as a review

## Context and Problem Statement

ADR 0001 put review state on the `sessionReviews` row and had readers count only `status = 'done'` rows. With the worker, pressing Review again sets a finished row back to `waiting`, which would hide the old review while the new one runs, and for good if all 3 tries fail.

## Considered Options

- Readers count a row whose `outcome` is set, whatever its status; a re-review leaves the old result on the row until the new one overwrites it
- Readers count only `done` rows, as ADR 0001 said, and the old review disappears during a re-review
- Keep the old result in a separate history table

## Decision Outcome

Chosen: count any row with a result, because it keeps the old review visible during a re-review and after a failed one without a second table to keep in step. The state columns stay on the row (`status`, `attempts`, `error`, `reviewedThrough`), and `sessionReviews_done_has_result_check` still guarantees a done row has its result.

## Consequences

Every reader that shows or counts a review filters on `outcome is not null`, never on `status = 'done'`; a `waiting`, `running` or `failed` row may carry the previous result. The unused `heartbeatAt` column is dropped (one worker needs no per-row liveness, ADR 0002); this supersedes ADR 0001.
