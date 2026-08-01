---
title: "Hand-written extraction regexes need adversarial real-world inputs, not just happy-path examples"
date: 2026-08-01
category: gotchas
tags: [regex, parsing, html, markdown, boundary-conditions]
component: packages/cli/src/watcher/artifact-extract.ts
severity: medium
status: implemented
applies_to: ["packages/cli/src/watcher/artifact-extract.ts"]
stage: [review]
evidence_count: 1
last_validated: 2026-08-01
source: review-fix@transitive-reference-closure
related: []
---

# Hand-written extraction regexes need adversarial real-world inputs, not just happy-path examples

## Problem

Two independent regex bugs surfaced in the same file during review, both from testing
only clean examples instead of realistic edge-case tokens:

1. `MARKDOWN_REFERENCE`'s capture group was `[^)\s]+` — it stops at the first `)`. A
   markdown link destination with a balanced parenthesis, like the common
   auto-dedupe screenshot filename `[shot](image(1).png)`, silently truncated to
   `image(1`, failed the existence check, and the reference was dropped with no
   warning.
2. `HTML_ATTR_REFERENCE` used `\b` as the attribute-name boundary. `\b` matches *any*
   word/non-word transition — including immediately after a hyphen or colon — so
   `data-src`, `xlink:href`, and `data-poster` were all incorrectly extracted as if
   they were bare `src`/`href`/`poster` attributes, directly violating the design's
   explicit "0 false positives" requirement.

## Insight

**`\b` and naive character-class exclusions look correct against the examples you
wrote yourself, and wrong against the examples the real world writes.** `\b` is a
word/non-word transition, not an "attribute name starts here" anchor — anything that
looks like `<prefix>-<name>` or `<namespace>:<name>` defeats it. A `[^delimiter]+`
capture group looks correct until the value legitimately contains the delimiter
character, which happens constantly with auto-generated filenames (numbered
duplicates in parens) and namespaced/prefixed identifiers.

## Solution

```ts
// file: packages/cli/src/watcher/artifact-extract.ts

// Before: \b also matches after a hyphen or colon (data-src, xlink:href)
// After: negative lookbehind rejects a preceding word char, hyphen, or colon
const HTML_ATTR_REFERENCE = /(?<![\w:-])(?:src|href|poster)\s*=\s*["']([^"']*)["']/gi

// Before: [^()\s]+ truncates at the first "(" in the destination
// After: one level of balanced parens is allowed inside the capture
const MARKDOWN_REFERENCE = /!?\[[^\]]*\]\(\s*((?:[^()\s]|\([^()]*\))+)/g
```

## Prevention / Reuse

- When writing a boundary-matching regex for a token that could be prefixed or
  namespaced (`data-*`, `xlink:*`, `aria-*`, etc.), don't reach for `\b` — use a
  negative lookbehind/lookahead that explicitly names what's *not* allowed to precede
  or follow.
- When capturing a value up to a delimiter, ask whether the value's own domain
  (filenames, URLs, identifiers) legitimately contains that delimiter, and if so,
  allow one level of it explicitly rather than excluding it outright.
- Test regex extractors against inputs from the domain's actual naming conventions
  (auto-dedupe suffixes, namespaced attributes) — not only hand-picked clean examples
  — before trusting a "0 false positives" or "captures everything" claim.

## Related

(none)
