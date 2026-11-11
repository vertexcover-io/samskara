---
status: active
date: 2026-11-12
source: .yok/rereview-new/artifacts/design.md (PR 5 of the review workflow)
tags: [ai-review, session-reviews, worker]
---

# A nightly re-review reads only the records its earlier review never read, numbers them after the old ones, and adds its problems to the old ones

## Context and Problem Statement

Once a session had an AI review, the nightly pick never took it again, so later work in it went unreviewed. A full redo would re-read everything and replace problems that fix runs may already have grouped, and the evidence of every saved problem cites export positions (`msg-N`) that `signals.run.recordIds` maps back to messages.

## Considered Options

- Read only new records, numbered after every old one, and append problems
- Re-export the whole session each pass, renumber, and replace problems
- Re-export the whole session each pass, renumber, and remap old problems' evidence to the new numbers

## Decision Outcome

Chosen: read only new records, numbered after every old one, and append problems, because messages sort by `lineNumber` across tracks and a subagent's lines restart at 1, so a fresh export moves old `msg-N` whenever new subagent work arrives; numbering new records after the old ones keeps every saved quote valid without rewriting stored evidence, and appending keeps problems a fix run already grouped. A record is new when its message is not in the earlier `recordIds`; the reviewer also sees the 20 records before the first new one and rewrites outcome and summary for the whole session. A `sessionReviews.newPartOnly` column, set only by the nightly re-pick, keeps the Review button's redo a full review that replaces the problems.

## Consequences

`signals.run.recordIds` grows across passes and is the only map from `msg-N` to a message: any code that rebuilds an export must number records through it (`recordsInReviewOrder`), never by position in a fresh export. Quote checks find records by position in the array, not by `seq`, since a re-review's export starts part-way.
