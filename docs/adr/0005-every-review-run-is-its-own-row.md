---
status: active
date: 2026-11-12
source: yok run review-runs (task text and design.md)
tags: [session-reviews, ai-review]
---

# Every review run is its own sessionReviews row, and a session shows its latest full run plus the new-part runs after it

## Context and Problem Statement

A session keeps growing after it is reviewed. Before this, a redo overwrote the one row per session and analyzer and deleted its problems, so history was lost and covering a few new messages meant re-reading the whole session.

## Considered Options

- A row per run: full runs and new-part runs (`newPartOnly`, `basedOn`, `lastMessageId`), at most one waiting or running per session and analyzer, readers show a chain
- One row per session and analyzer, the old result carried on the row during a redo
- One row per session and analyzer, earlier results copied into a history table

## Decision Outcome

Chosen: a row per run, because each run's problems cite records by its own `msg-N` numbering through its own `signals.run.recordIds`, so a run's result is only readable whole and next to its own records; a row per run keeps that true without copying. The partial unique index `sessionReviews_one_active_per_session` (status waiting or running) replaces the unique (sessionId, analyzer) key. A new-part run reads the messages whose `timestamp` is later than its base run's `lastMessageId` message in every track, not a line number, because each subagent transcript numbers its lines from 1.

## Consequences

Every reader shows or counts reviews through `shownRun` (reviews.repo.ts) and `status = 'done'`, never `outcome is not null`; older runs keep their rows and problems.
