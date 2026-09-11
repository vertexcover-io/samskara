# Writing the playbook

The playbook (this folder) holds the durable working rules of this
project: how we run initiatives, write for each other, test, and
delegate. Sessions add rules as incidents earn them. This file says how
to write those entries so the playbook stays readable to someone who
was not there.

## What belongs in a playbook rule

A rule that would still be true on the next initiative, stated so a
reader outside the incident understands it. Each rule keeps the story
that earned it — the stories are what keep the rules alive — but told
in plain words: what someone did, what broke, what we do now.

## What does not belong

Feature internals. Tool flags, sandbox names, service classes, commit
hashes, API routes — anything that is only meaningful inside one
initiative. Those details live in that initiative's `log.md` and
`RESUME.md` under `writeup/<initiative>/`; the playbook rule refers to
them generically ("a sandbox flag", "an internal service") or not at
all. The test: if the feature were deleted tomorrow, the rule should
read unchanged.

The exception is commands a future session must literally type —
`pgrep`, a log path to check, a script to run. Operational commands are
the rule's payload; feature internals are noise.

## How a rule gets here

1. The incident happens; the session records it where it worked — the
   initiative's log, its RESUME, a chat.
2. If the lesson generalizes, the session adds it to the matching
   playbook doc (tone rules to `tone_and_taste.md`, initiative-page
   rules to `mission-control.md`, and so on), phrased by this file's
   standard.
3. When a new rule lands in a doc, sweep that doc's existing entries
   against it in the same pass — rules that only ever apply forward
   don't clean anything up.

## Why this file exists

A rule about writing grades was added with the incident's sandbox CLI
flags and commands quoted verbatim; the owner pointed out that
feature-specific jargon was starting to pollute the playbook. The rule
was right, the phrasing wasn't. This file is where that standard —
and future ones about the playbook itself — get written down.

It happened again with a rule about scoping checks: written with one
initiative's module names and tool flags, and the drift had spread into
the neighboring entries on the same page. Two fixes came out of it:
this file is now a gated contract in the repo instructions (open and
quote it before editing anything under `docs/playbook/`), and a new
rule landing in a doc means sweeping that doc's older entries against
the standard in the same pass — which is how the neighbors got caught.
