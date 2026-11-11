---
status: active
date: 2026-11-11
source: yok run review-worker (task text and design.md)
tags: [worker, ai-review, session-reviews, learning-runs]
---

# AI reviews and fix runs run in one forked worker that claims waiting rows from the database

## Context and Problem Statement

A review in progress lived in server memory and a fix run was marked failed on boot, so every restart lost work someone asked for. Agent work also shared the API's event loop, and an uncaught error in it exits the whole API (`installCrashHandlers`).

## Considered Options

- One worker process the server forks, claiming `waiting` rows with `for update skip locked`, guarded by a Postgres advisory lock so only one worker works
- The same database queue claimed inside the API process
- Several worker processes, each marking the rows it holds so the others can take back a dead one's work

## Decision Outcome

Chosen: one forked worker, because the database rows make a restart lose nothing while a separate process keeps a crash or a slow review out of the API, and a single worker needs no per-row liveness. Per-row liveness for several workers is recorded in ADR 0003 as dropped (`heartbeatAt`).

## Consequences

New triggers (nightly picks, PR merged) must queue a row and notify the worker, never run an agent in the API. A second worker needs per-row liveness first: the worker's start-up reset assumes it is the only one.
