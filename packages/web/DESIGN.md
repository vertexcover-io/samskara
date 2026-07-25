---
name: Samskara
description: Process provenance for AI-assisted software development.
colors:
  paper: "#e9ebef"
  paper-2: "#eef0f3"
  panel: "#f6f7f9"
  panel-2: "#fbfcfd"
  rule: "#cfd4db"
  ink: "#1a1c20"
  ink-2: "#2f343c"
  ink-soft: "#545b64"
  faded: "#5b616b"
  stamp: "#9e2a2b"
  custody: "#2b4a78"
  agent-audit: "#3a6a4e"
  agent-test: "#6f4586"
  agent-perf: "#8a5a1f"
  ok: "#2f6b45"
  warn: "#8a5a1f"
  err: "#9e2a2b"
typography:
  case-title:
    fontFamily: "ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.375rem"
    fontWeight: 600
    lineHeight: "1.25"
  lead:
    fontFamily: "ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 400
    lineHeight: "1.6"
  body:
    fontFamily: "ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: "1.5"
  evidence:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "0.78rem"
    fontWeight: 400
    lineHeight: "1.5"
  label:
    fontFamily: "ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.656rem"
    fontWeight: 600
    lineHeight: "1.2"
    letterSpacing: "0.12em"
    textTransform: "uppercase"
rounded:
  xs: "2px"
  sm: "3px"
  pill: "999px"
spacing:
  xs: "0.25rem"
  sm: "0.5rem"
  md: "1rem"
  lg: "1.5rem"
components:
  status-stamp:
    border: "1.5px solid currentColor"
    rounded: "{rounded.sm}"
    transform: "rotate(-2deg)"
    typography: "{typography.label}"
  subagent-annex:
    backgroundColor: "{colors.panel}"
    border: "1px solid {colors.rule}"
    borderTop: "2px solid <lane>"
    rounded: "{rounded.sm}"
---

# Design System: Samskara

## Overview

**Creative North Star: "The Engineering Case File"**

Samskara's visual world combines three complementary behaviors: the **Engineering Case File**
connects intent, evidence, activity, and implementation; the **Developer Flight Recorder**
preserves the sequence of work for replay and review; and the **Living Engineering Workbench**
keeps that context fast and usable. The case file is the primary metaphor; flight recorder is the
provenance behavior; workbench is the interaction posture.

The session-detail surface is the first full expression of this world in a **technical register**:
a captured coding-agent session is treated as *filed evidence*, not a chat log. Every record hangs
off a **custody spine** and carries a chain-of-custody line (which agent, which tool, which
timestamp). It deliberately refuses the two category defaults — the chat-bubble transcript and the
near-black neon AI-observability dashboard.

**Key characteristics:**
- Make intent, evidence, and the next action easy to locate.
- Prefer dense, legible evidence over decorative chrome.
- Keep navigation shallow and task-oriented (divider tabs, not a sidebar maze).
- Make provenance visible through explicit custody boundaries, not telemetry noise.
- Known facts render in solid ink; missing or inferred metadata renders in hairline/dotted faded ink.

## Colors

A **cool ledger-paper** palette — explicitly *not* warm-cream editorial (the AI-cliché this world
avoids). One official stamp-red and one custody-ink indigo do the semantic work; muted per-agent
tints distinguish subagent lanes without turning saturated.

### Ground & structure
- **Ledger paper** (`#e9ebef`) — page canvas, cool gray. Panels lift to `#f6f7f9` / `#fbfcfd`.
- **Hairline rule** (`#cfd4db`) — the default divider; 1px, never a colored side-rail above 1px.
- **Ink** (`#1a1c20`) solid/known · **Ink-soft** (`#545b64`) secondary · **Faded** (`#5b616b`)
  inferred/missing, always paired with dotted underline or italic so status is never color-only.

### Official inks
- **Stamp red** (`#9e2a2b`) — status stamps, error flags, active-tab marker, exhibit numbers. Sparing.
- **Custody indigo** (`#2b4a78`) — the provenance spine, the main agent, provenance links.

### Agent lanes (muted, ledger-appropriate)
- **Auditor green** (`#3a6a4e`), **Test violet** (`#6f4586`), **Perf ochre** (`#8a5a1f`).
  Each subagent owns one lane, echoed in its seal ring, spawn tag, spine node, and rail dot.

### Semantic
- `ok` `#2f6b45` (Cleared) · `warn` `#8a5a1f` (Interrupted/Repeat) · `err` `#9e2a2b` (Failed).
  Every status also carries a word and a shape, never color alone.

### Named rules
**The Custody Rule.** Every record shows who produced it and when; provenance is structural, not a tooltip.
**The Known-vs-Missing Rule.** Solid ink is confirmed fact; hairline/dotted faded ink is missing,
inferred, or permission-denied — and it says so in words.

## Typography

**One family per role, no display/body pairing.** A workhorse system **sans** carries titles,
prose, labels, and controls; a **monospace** carries all evidence data — timestamps, tool names,
IDs, token counts, paths, code, and diffs. Monospace is used for *measurement and code*, never as a
"technical" costume for prose.

### Ramp (rem, fixed — not fluid)
- **Case title** — 1.375rem / 600 (masthead subject line).
- **Lead** — 0.9375rem / 400 (overview prose).
- **Body** — 0.875rem / 400 (record prose, base).
- **Evidence (mono)** — ~0.78rem / tabular-nums (data, code, custody lines).
- **Label** — 0.656rem / 600, uppercase, 0.12em tracked (divider labels, `.lbl` small-caps).

### Named rules
**The Tight-Scale Rule (Operate).** Steps sit close together on purpose; hierarchy is carried by
weight, case, tracked small-caps, color, and the sans/mono split — not by size contrast. A wide
type ramp would add noise to a dense evidence surface.
**The Read-First Rule.** Text answers *what this is* and *what to do next* before supporting context.

## Layout

- **Masthead file-cover** → **divider tabs** (Overview / Timeline / Files / Tools) → **filter+search
  toolbar** → **agent rail + custody-spine timeline**. No permanent metadata inspector.
- The **custody spine** is a 2px indigo vertical line; each record marks it with a rotated diamond
  **fold node** (agent tinted), or a filled square for events.
- **Agent navigator rail** (232px) lists the main agent and bounded subagent spans; it focuses an
  agent, it is not an inspector. Collapses to a responsive grid under 900px.
- Responsive behavior is **structural**: rail → grid, dividers scroll, facts reflow 6→3→2 columns,
  cards go full-width. Type stays on the fixed rem ramp.

## Shapes

Small radii only (`2px` / `3px`), pill for chips. Flat, lightweight surfaces with a single soft
elevation (`0 1px 2px`, `0 6px 18px -8px`) reserved for the **subagent annex** — the one card that
must read as lifted from the file. Stamps and exhibit numbers use a slight `rotate(-2deg…-4deg)` to
read as pressed ink.

## Components

- **Status stamp** — outlined, tracked small-caps, rotated; carries capture state and outcomes.
- **Custody line** — mono, `agent / tool / timestamp`, indigo keys.
- **Message renderers (one system, distinct treatments):** user prompt (ink left-rule panel),
  assistant prose/code, thinking (dashed disclosure, collapsed), tool call (procedure log with
  structured input), tool result (Cleared/Failed outcome + disclosure preview), subagent
  spawn/return events, system event, artifact/exhibit (numbered, provenance link), error (red flag
  box + recovery). Records are never flattened into identical chat bubbles.
- **Subagent annex** — a sealed sub-dossier filed inline on the spine: seal, status, task summary,
  counts, parent link. Lane identity is a **folder-tab top edge** (2px), never a >1px side-rail.
- **Focus mode (memorable moment)** — opening an annex isolates its full filed conversation and
  dims the rest of the spine while preserving the return point; the main narrative is never removed.
- **States** — every interactive control has hover, focus-visible (2px stamp-red ring), active,
  disabled. Surface states: loading skeleton, live/partial, completed, capture-failed, empty,
  no-filter-results. Reduced-motion disables all animation.

## Motion

150–250ms, state-conveying only (annex open, focus isolate, filter apply, live pulse). No
orchestrated page-load sequences. `prefers-reduced-motion` removes all animation and smooth scroll.

## Do's and Don'ts

### Do
- Hang every record on the custody spine with visible provenance.
- Use mono for data/code/measurement and sans for prose.
- Keep the main-agent narrative present even when a subagent is focused.
- Say "missing / permission-denied" in words, with dotted faded ink.

### Don't
- Don't use warm-cream + serif editorial styling (the register this world rejects).
- Don't add colored side-rails above 1px on cards; lane identity is a folder-tab top edge + seal.
- Don't build a permanent metadata sidebar or a multi-level nav maze.
- Don't flatten records into uniform chat bubbles or communicate status by color alone.

## Provisional / to settle in the React port

- Exact mono/sans faces (currently system stacks) may be pinned during the React extraction.
- Whether the parallel-map (time-aligned lanes) view is a default tab or a focused secondary mode.
- Live-session update behavior and how much raw tool input shows by default.
