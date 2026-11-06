---
status: active
date: 2026-11-06
source: .yok/habit-fixes/artifacts/design.md
tags: [core-learnings, fix-page]
---

# A fix in parts is stored as heading blocks inside the learning's fix text

## Context and Problem Statement

One habit can need a different change at each moment it shows up, so a learning's fix may now
have 2 to 4 parts, each a heading and a change. The parts have to be stored somewhere the fix
page can split back into sections.

## Considered Options

- Heading blocks inside the existing `fix` text: `### HEADING`, a blank line, the change, a blank line between parts
- A new jsonb column holding the parts, like the `story` column
- JSON written into the existing `fix` text

## Decision Outcome

Chosen: heading blocks inside `fix`, because the text still reads as a plain fix wherever it is
shown raw (the command line's learn output, the list's fallback when a fix has no plain-words
line), where JSON would not; one splitter in core, `fixParts`, turns it back into parts.

## Consequences

Every reader of `learning.fix` must treat a text starting with `### ` as possibly parts and go
through `fixParts`, never its own parsing. Moving to a column later means a data migration of
every saved fix in parts.
