# Feature doc writing guide

A feature doc explains one feature so a human can understand it and an agent can act on it,
without reading the code. It lives in `docs/html_docs/<feature>/` as two files that carry the
same content: `feature.md` (the source of truth) and `feature.html` (the human page).

## The two files and which one wins

- **`feature.md` is the source of truth.** Agents read this one — it is cheap in context,
  greppable, and diffs cleanly in review. When code changes, this file changes in the same
  commit, and the HTML is refreshed to match.
- **`feature.html` is a rendering.** Built on the writeup skill's `SHELL.html` (house look,
  light theme, no external assets). It exists because a person skimming a pipeline with six
  stages reads a page faster than a wall of markdown. It adds nothing the md does not say.
  If the two ever disagree, the md is right and the html gets fixed.

## What a feature doc must answer, in this order

Readers build understanding top to bottom, so the order is part of the content.

1. **What it is, in three sentences.** What the feature does, who it is for, what it
   deliberately is not. No history, no motivation essay — the project-understanding doc
   carries the why; this carries the what and the how.
2. **The flow end to end.** A numbered walk from trigger to visible result. One stage per
   step, each step a complete sentence: what enters, what happens, what leaves. A reader who
   stops here still knows how the feature works.
3. **Triggers and entry points.** Every way the flow starts — HTTP route, CLI command,
   background loop — with the real command or path, and who is allowed to pull each one.
4. **The data shape.** The vocabulary the feature speaks internally (event kinds, table
   columns, message types — whatever the smallest honest unit is). Small table, one row per
   unit, what each unit means.
5. **The ontology.** Every enumerated state the feature can be in: the values, where each
   is enforced (zod, check constraint, code constant), the legal combinations (which pairs
   can coexist, which are mutually exclusive and why), and the lifecycle transitions (from
   state, to state, who may move it, what never comes back). If a state is not in the
   lists, it cannot exist — that sentence is the point of the section. UI labels that
   diverge from stored values (a button saying "Retire" that writes `superseded`) are named
   here, because that divergence is exactly what confuses a reader with the page open and
   the database beside them.
6. **The decision rules, with their real thresholds.** If the feature classifies, scores, or
   branches, every rule appears with the constant that governs it (`3`, not "several") and
   the precedence order when several rules could fire. Thresholds without numbers are prose,
   not rules.
7. **Where the code is.** File references as typography, not prose — mono, set apart, with
   the one-line job of each file. Never inline paths mid-sentence.
8. **What is deliberately not there.** Known gaps, deferred work, and known-wrong behavior,
   stated plainly. A feature doc that hides the gaps teaches the reader to trust it too much.
9. **How to see it work by hand.** The exact commands a person runs to watch the feature do
   its job on this machine, and what output proves it worked.

## Rules that bind both files

- House voice throughout: `docs/playbook/tone_and_taste.md`. Complete sentences, real names,
  real numbers, no grading words, no decoration that replaces the sentence.
- **Every line stands alone.** A table row, a fold summary, a bullet — each carries its own
  context, because both audiences jump in mid-page.
- **State the current state.** Written in present tense about what the code does *today*. If
  something is planned, it lives in the gaps section marked as planned, not woven into the
  flow as if it existed.
- **No maintenance log.** Git carries history; the doc carries the present. No "recently
  changed", no dates in prose.
- Keep the md under ~200 lines. If it needs more, the feature has two features in it, or the
  detail belongs in a fold in the html and a short section in the md.

## Making the html

Use the writeup skill at `docs/skills/writeup/` (this repo's canonical copy — SKILL.md for
the rules, `SHELL.html` for the shell): read `SHELL.html`, drop the md's content into its
structure (`ol.walk` for the flow, `div.card` with `span.file` per stage, `.tablewrap`
tables, `details.fold` for evidence, `nav.anchornav` listing the sections), change the
title, write it beside the md. Self-contained — no fonts or scripts from anywhere else.
Light theme only, flat geometry, by the shell's own comment: do not add a dark mode or a
theme button back.
