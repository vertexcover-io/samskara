---
status: active
date: 2026-11-11
source: yok run pr-trigger (task text and design.md)
tags: [worker, session-reviews, pull-requests, worker-to-github]
---

# The nightly pick reads pull request state from GitHub just before it picks, and a merged or closed PR makes its session ready

## Context and Problem Statement

The nightly pick queued a session only after 6 quiet hours, and the server had no record of whether a pull request a session opened was still open. Reviewing a session as soon as its work lands or is dropped needs that state.

## Considered Options

- The worker asks GitHub's GraphQL API once a night, just before the pick, about the open PRs of that night's candidate sessions: 50 per request, at most 200 a night, least recently checked first; it saves `state`, `closedAt` and `checkedAt` on `pullRequests`
- The same check with one REST call per pull request
- The same check with no cap on how many pull requests a night reads
- Reading the state on every claim pass, or when a session's messages are ingested

## Decision Outcome

Chosen: GraphQL batches just before the pick, because a night costs at most 4 requests, the state is fresh exactly when the pick reads it, and the GitHub calls run outside the pick's single stamp-and-queue statement so that statement stays atomic and short. Without `LEARNINGS_HARNESS_GITHUB_TOKEN`, or when GitHub fails, the pick runs on the 6-hour rule alone.

## Consequences

`pullRequests.state` is refreshed only for candidate sessions' open PRs, once a night; any other reader (UI, re-review) must treat it as possibly stale, and `checkedAt` says how stale.
