---
status: active
date: 2026-11-12
source: yok run reader-leads (task text and design.md)
tags: [ai-review, session-reviews, worker]
---

# A review keeps each reader's reply in its own table until the review ends, keyed by the hash of the records it read

## Context and Problem Statement

The worker retries a failed review try up to 3 times, and every retry paid for every reader again. Reader replies lived only in memory, and the production worker runs in Docker, so only Postgres survives a restart or a deploy.

## Considered Options

- A `reviewReaderReplies` table, one row per finished reader, keyed by (`reviewId`, `pieceHash`) and deleted with its `sessionReviews` row
- A jsonb column on `sessionReviews` holding every reply of the current review
- Files on the worker container's disk

## Decision Outcome

Chosen: the `reviewReaderReplies` table, because up to 4 readers save at once and a table takes each as a plain insert, where a jsonb column on the queue row the worker polls would need a read-modify-write per reader, and a container's disk is lost on deploy. This does not move review state off the row (ADR 0003): the table holds only temporary reader replies. `pieceHash` is SHA-256 of the piece's records as the reader was shown them, without the session meta header, whose `endedAt` moves with every new message; keying by first and last message id was rejected because it misses a late tool result inside the range. Instructions, harness and model stay out of the key: retries of one row share them, and a new review clears the replies instead.

## Consequences

Every path that ends or restarts a review deletes its replies: `upsertReview` (done), `failReviewAttempt` and `requeueRunningReviews` (failed for good), and `claimReview` (first try).
Changing what a reader is shown changes `pieceHash`, which only costs a rerun.
