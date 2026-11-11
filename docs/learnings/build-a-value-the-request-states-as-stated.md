---
signal: Use when the request states a concrete value (a limit, count, interval or default) and you think a different value would be better
paths: ["**"]
tags: [requirements, design]
strength: hard-rule
---
# Build a value the request states as stated

Build a value the request states as stated. If you think it is wrong, ask one direct question before changing it, never as an unconfirmed reading in the design. When the user points back to it, restore it without asking.

**Occurrences:**
- 2026-11-11 · the request said at most 4 agent processes; the design made `AI_AGENT_SLOTS` default to 2 as an unconfirmed reading, and when the user pointed back to 4 the agent asked again before restoring it.

**Stale when:** an ADR under `docs/adr/` says values in a request are suggestions the design may change without asking.
