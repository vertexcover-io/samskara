---
name: Samskara
description: Process provenance for AI-assisted software development.
colors:
  paper: "#e3e6ea"
  paper-2: "#eaedf1"
  panel: "#f4f6f8"
  panel-2: "#ffffff"
  rule: "#b0b9c6"
  rule-soft: "#d2d8e0"
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
  outcome-stamp:
    textColor: "{colors.ok}"
    typography: "{typography.label}"
  subagent-annex:
    backgroundColor: "{colors.panel}"
    border: "1px solid {colors.rule}"
    borderTop: "2px solid <lane>"
    rounded: "{rounded.sm}"
  record-user:
    backgroundColor: "{colors.panel-2}"
    borderLeft: "2px solid {colors.ink}"
    rounded: "{rounded.xs}"
  record-assistant:
    backgroundColor: "{colors.panel-2}"
    borderLeft: "2px solid {colors.custody}"
    rounded: "{rounded.xs}"
  record-aside:
    backgroundColor: "{colors.panel-2}"
    borderLeft: "2px solid {colors.rule}"
    rounded: "{rounded.xs}"
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
- **Ledger paper** — page canvas, cool gray and the darkest surface in the system. Panels lift
  through `panel` to a true-white `panel-2`, so a card reads as resting *on* the page rather than
  dissolving into it.
- **Hairline rule** — the default divider, 1px, held near **2:1 against white**. A lighter rule
  reads as a suggestion rather than a boundary. `rule-soft` is the within-group divider.
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
A commit's subject leads its row; the sha, branch, and diffstat are the evidence beneath it.
**The One Clock Rule.** Every stamp in the app renders in the reader's own timezone, through one
module. Recency reads relative (`3 hours ago`, `yesterday`) with the exact moment one hover away on
`title`; past thirty days it becomes a date, because "5 weeks ago" locates nothing. A stamp from the
future reads as *just now* rather than counting backwards — clock skew between the capturing machine
and the reader is ordinary. Unparseable reads `--`, never an invented distance.

## Layout

- **Masthead file-cover** → **divider tabs** (Conversation / Tool Calls / Artifacts / Commits /
  Pull Requests) → **agent rail + custody-spine timeline**. No permanent metadata inspector. The
  masthead and the tab strip both pin; everything they cover reads a published `--sticky-head` to
  clear them, so a permalinked record lands below the bars rather than behind them.
- The **custody spine** is a 2px hairline running down the centre of a 2rem gutter, marked at each
  record by a 10px round **node**: filled for what the human sent, hollow for everything else.
  Line and node are sized in **px, not rem** — the root font scales on wide viewports, and a
  rem-sized node drifts off a px-positioned line.
- **Agent navigator rail** (232px) lists the main agent and bounded subagent spans; it focuses an
  agent, it is not an inspector. Collapses to a responsive grid under 900px.
- A **parked panel** (the agent rail, the artifact index) sticks below `--sticky-head`, ends at its
  own content, and scrolls internally only once it outgrows the viewport. It never stretches to a
  sibling's height — an unbounded tinted column with no bottom edge is the failure this prevents.
- Responsive behavior is **structural**: rail → grid, dividers scroll, facts reflow 6→3→2 columns,
  cards go full-width. Type stays on the fixed rem ramp.

## Elevation & Depth

Depth is carried by **tonal layering first** — the page is the darkest surface, panels lift toward
white, and a 2:1 hairline draws the boundary. Shadow is the exception, not the method, and the
system holds exactly **two steps**:

### Shadow vocabulary
- **Card** (`0 1px 2px -1px rgb(26 28 32 / 0.1), 0 3px 10px -4px rgb(26 28 32 / 0.16)`) — a
  surface resting on the page: project cards, the sign-in panel.
- **Overlay** (`0 12px 32px -14px rgb(26 28 32 / 0.5)`) — a surface floating above it: the account
  menu, the pairing dialog.

### Named rules
**The Two-Step Rule.** Depth is a choice between `card` and `overlay`. A per-component `rgba()`
guess is how three different shadows once meant the same thing; if neither step fits, the surface
does not need a shadow.

## Shapes

Small radii only (`2px` / `3px`), pill for chips. Flat, lightweight surfaces throughout; the
**subagent annex** reads as lifted from the file through its folder-tab top edge rather than
through elevation.

## Components

- **Outcome stamp** — tracked small-caps in the semantic ink (`Cleared` / `Failed`); the word
  carries the state, the color only reinforces it. Not outlined and not rotated.
- **Custody line** — one mono line carrying a record's provenance, custody-indigo on the
  identifier: `sha · branch · diffstat · repo · when`. Commits and pull requests file their
  evidence on this line beneath the subject rather than stacking it into separate rows.
- **Actor tone** — every transcript record resolves to one of three tones, and the tone drives its
  **gutter, spine node, and label color together** so they read as one signal rather than three
  decorations: **user** (ink, filled node), **assistant** (custody, hollow node), **aside** —
  injections, branch events, system records — (rule, hollow node). The tone is published on a
  `data-actor` attribute as well as the classes, so attribution is assertable without pinning the
  styling that expresses it.
- **Message renderers (one system, distinct treatments):** user prompt, assistant prose/code,
  thinking (dashed disclosure, collapsed), tool call (procedure log with structured input), tool
  result (Cleared/Failed outcome + disclosure preview), subagent spawn/return events, system event,
  artifact (provenance link), error (red flag box + recovery). Records are never flattened into
  identical chat bubbles.
- **Subagent annex** — a sealed sub-dossier filed inline on the spine: seal, status, task summary,
  counts, parent link. Lane identity is a **folder-tab top edge** (2px), never a >1px side-rail.
- **Focus mode (memorable moment)** — opening an annex isolates its full filed conversation and
  dims the rest of the spine while preserving the return point; the main narrative is never removed.
- **Artifact index** — the parked left panel of the Artifacts tab: filename filter, four kind chips
  on a two-column grid carrying their own counts, an `A added · M modified` legend for the margin
  marks, and the tree. It takes no heading — the tab above already names it.
- **States** — every interactive control has hover, focus-visible, active, disabled. The focus ring
  is a 2px stamp-red outline **plus a panel-2 halo filling its offset**, because the ring alone
  disappears wherever focus lands on an ink or custody fill. Surface states: loading skeleton,
  live/partial, completed, capture-failed, empty, no-filter-results. Reduced-motion disables all
  animation.

## Motion

150–250ms, state-conveying only (annex open, focus isolate, filter apply, live pulse). No
orchestrated page-load sequences. `prefers-reduced-motion` removes all animation and smooth scroll.

## Do's and Don'ts

### Do
- Hang every record on the custody spine with visible provenance.
- Use mono for data/code/measurement and sans for prose.
- Keep the main-agent narrative present even when a subagent is focused.
- Say "missing / permission-denied" in words, with dotted faded ink.
- Carry an actor's identity on all three of its marks at once — gutter, spine node, label.
- Reach for `card` or `overlay` when a surface needs depth, and for neither when it doesn't.
- Let a side panel end at its own content and park; the page is the scroll region.

### Don't
- Don't use warm-cream + serif editorial styling (the register this world rejects).
- Don't mark **lane** identity with a colored side-rail: a subagent's lane is a folder-tab top edge
  (2px) + seal. The 2px left gutter is reserved for **actor** identity on a transcript record — a
  different signal, and the only sanctioned left rule.
- Don't write a per-component `rgba()` shadow, or stack scroll regions inside the page.
- Don't build a permanent metadata sidebar or a multi-level nav maze.
- Don't flatten records into uniform chat bubbles or communicate status by color alone.
- Don't restate in a panel what the tab above it already names.

## Provisional / still to settle

- Exact mono/sans faces. The React surface ships on system stacks; pinning real faces is open.
- Whether the parallel-map (time-aligned lanes) view is a default tab or a focused secondary mode.
- Live-session update behavior and how much raw tool input shows by default.
- A dark scheme. The tokens are structured for it, but the surface has not been audited for the
  hardcoded escapes that would fight it — the artifact preview's white iframe, Shiki pinned to a
  light theme, and every ink-fill/panel-text inversion pair.
