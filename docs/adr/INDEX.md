# Architecture Decision Records

- [0002 AI reviews and fix runs run in one forked worker that claims waiting rows from the database](0002-reviews-and-fix-runs-run-in-one-forked-worker.md) · active · 2026-11-11 · worker, ai-review, session-reviews, learning-runs · the API only queues rows and wakes the worker; no agent runs in the API; one worker at a time
- [0003 A review's state lives on its sessionReviews row, and any row with a result counts as a review](0003-a-review-row-with-a-result-counts-as-a-review.md) · inactive · 2026-11-11 · session-reviews, ai-review · superseded by 0005
- [0005 Every review run is its own sessionReviews row, and a session shows its latest full run plus the new-part runs after it](0005-every-review-run-is-its-own-row.md) · active · 2026-11-12 · session-reviews, ai-review · readers use shownRun and status done; a new-part run reads messages later in time than its base run's lastMessageId
