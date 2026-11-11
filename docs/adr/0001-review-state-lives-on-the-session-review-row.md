---
status: inactive
date: 2026-11-10
source: yok run review-state (task text)
tags: [session-reviews, ai-review]
---

# A review's state lives on its sessionReviews row, and only done rows count as reviews

## Context and Problem Statement

Reviews in progress live only in server memory, so a restart loses them. A worker that survives restarts needs the database to say which reviews are waiting, running, done or failed, and which message each review read up to.

## Considered Options

- State on the sessionReviews row: `status`, `attempts`, `error`, `heartbeatAt` and `reviewedThrough` beside the result, with `outcome`, `summary` and `signals` nullable
- A separate review-queue table for the state, with sessionReviews holding only finished results

## Decision Outcome

Chosen: state on the sessionReviews row, because a session already has exactly one row per analyzer (`sessionReviews_session_analyzer_unique`), so one row moving waiting -> running -> done | failed needs no second table kept in step with it. `reviewedThrough` also belongs beside the result it describes. Every reader that shows or counts a review filters to `status = 'done'`, and the check `sessionReviews_done_has_result_check` refuses a done row without a result, so readers can rely on a done row being complete.

## Consequences

Any new reader of sessionReviews must filter to `status = 'done'`, or it will see rows with no result. A re-review that sets a done row back to waiting hides the old result until the new one lands, unless the worker keeps the result on the row while it waits.
