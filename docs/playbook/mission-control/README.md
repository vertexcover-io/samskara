# Mission control: the shared picture of one initiative

Companion pages: [`watchers.md`](watchers.md) — no background work or
subagent runs unobserved; arm the watcher in the same breath as the run.
[`../cost_of_checks.md`](../cost_of_checks.md) — when an expensive check
is worth running again, and when it's just the ritual.

One rule for anything long-running, on the page and in chat: the moment
a long run or a subagent starts, say what is running, the clock time it
should finish, and what happens after — and say it again if the estimate
changes. The owner should never have to ask how long something will
take; if they do, the estimate was missing or buried.

## Why it exists

The person running this project is thinking about ten things at once.
An agent session starts remembering nothing. Mission control is the one
page that holds the shared picture of one initiative so that either of
them can arrive cold, read for three minutes, and act — without asking
anyone, without scrollback, without re-deriving context.

That is the whole purpose. Every sentence on the page earns its place
by serving the reader who just arrived. Nothing on it exists for the
writer. The first version of the test-framework page failed exactly
this way: it grew a long session log that the owner never once read,
state repeated in four sections that drifted apart, and design
reference filled the middle of the page. Each session patched its own
layer on top until only a rewrite could fix it.

## How it talks

The model to imitate is not a template, it is two pages that already
work: `docs/verb_service_usage_docs/services/experiment-run-service/`
and `writeup/pattern-engineering-audit/report.html`. What makes them
work:

- **A one-line verdict at the top** that says the situation, including
  the bad part: "Strong agent harness, but env files with real
  credentials are tracked in git." A reader who stops there has the
  truth.
- **Every claim carries its own evidence** — the number, the file
  path, the command, the count ("18 of 23 verb services save state
  through this service"). A claim without its evidence is an opinion.
- **Worst first.** The reader's attention goes to what matters most,
  so that is what comes first.
- **It reads without its author.** No sentence needs a person in chat
  to explain what it meant.

Voice rules are `tone_and_taste.md` in this folder — plain sentences,
bold as the focus map, no epigrams. That file wins on wording.

## How it looks

The look is the DeepKlarity report design — the same one the test
dashboard and the pattern-engineering-audit report use (that report's
`report.html` is the CSS source: embedded Manrope and JetBrains Mono,
mono uppercase section labels with the blue dash, a verdict headline,
meter rows, finding cards, detail behind closed toggles, no CDN and no
network needed). The owner picked this design; reuse its CSS rather
than restyling. The older notes below still hold where they don't
conflict:

- **Always light.** The page pins `data-theme="light"` and ships no
  dark palette, matching the dashboard and the example pages.
- **A soft page ground with one white card per concern.** The cards do
  the sectioning; the eye finds "Next steps" by its card, not by
  scanning headings in a wall of text.
- **A stat-tile row at the top**: a big number, a bold claim under it,
  and a small grey sentence with the evidence ("2 / 24 — verbs pass in
  mock mode — both AFM verbs, from a fresh seed on the isolated
  stack"). The tile is the claim-with-evidence pattern in visual form;
  a tile whose sentence is missing is just a number and gets cut.
- **Status pills in tables** — open / fixed / worked around — colored,
  and always carrying the word, never color alone.
- **Done checklist items stay readable**: muted, never struck through —
  their proof is still information.
- **Long pages get an anchor nav.** A page long enough to make the
  owner scroll blind gets a slim sticky bar of section links under the
  header. Use the shared writeup shell's pattern for this rather than
  re-deriving one — the shell carries it so no page has to invent its
  own.
- **Heavy secondary material folds.** A big table or a walkthrough's
  detail sits behind a closed accordion whose summary line keeps the
  one-sentence outcome visible, so the owner reads summaries and opens
  only what they need. A large table left open mid-page pushes
  everything after it out of the read.
- **Issue lists render as condensed expandable rows.** Each row shows a
  name, a one-line status, and a status pill; the detail sits behind
  the row's fold, moved there verbatim from wherever it was written,
  never rewritten into the summary line.
- **A tracked section carries its own totals.** A section that tracks
  work shows a small muted line — N tasks: done / open / blocked — so
  the shape of the work is visible without reading every row. When the
  section is generated, the totals line is generated with it.
- Decoration is still bounded by the tone doc's test: visual structure
  that carries the reading (cards, tiles, a colored status word) is
  good; decoration that replaces the sentence (a bare count, an
  unexplained badge) is not.

## What goes on the page

Five questions, in reading order. One place per answer — if a fact
appears twice, one of the copies will eventually be wrong.

1. **Where are we?** A verdict line, then a short honest grade per
   area of the plan, each grade one sentence with its evidence.
2. **What needs the owner?** Decisions only a person can make, each
   with what it costs while it waits. This section is either
   unmissable or it says "nothing right now". Nothing else on the
   page may block on a human.
3. **What happens next?** Ordered, granular, agent-runnable steps.
   Only what is actually next — far-off milestones stay in the
   roadmap.
4. **What does done look like?** The roadmap: checkboxes, one claim
   per box, each open box saying what would close it, each gating box
   carrying its own verification requirement inside it. A box is
   checked only on verified work.
5. **What is broken or open?** A worst-first table — what, where,
   status — with short cells. The story behind a row goes in the log
   or a linked page, never in the cell.

Settled decisions are not a section. A decision lives inline where it
matters ("sim is only ever started by a person — it can get stuck")
and in RESUME.md for agents, who are the ones tempted to re-open it.

## What stays off the page

- **History.** The log lives in `log.md` next to the page: append-only,
  one entry per session, newest first, same voice. It exists so a
  session can audit how things got here; the owner is not expected to
  read it, and no current fact may live only there.
- **Design and reference.** The strategy, structures, signatures and
  tables live in their canonical doc (for the test framework,
  `docs/tests/testing_strategy.md`); the page links to them. The page
  never carries a second copy of a design.
- **Live data.** Counts, durations and per-test results belong to the
  instrument (the dashboard); the page links to it and never mirrors
  its numbers, because mirrored numbers are stale numbers.

## Mechanics

- The initiative folder is `writeup/<initiative>/` and holds
  `mission-control.html`, `log.md` and `RESUME.md`. The page is for
  people, RESUME is the machine-facing entry point; where they
  disagree, the page wins and RESUME gets fixed.
- Day to day, open the file locally — every edit shows on refresh. A
  published artifact is a snapshot for sharing; republish at
  milestones, always to the same URL.
- When an initiative keeps a task board (`board.csv`), it is the one
  place task state is written — the page's "What happens next" and
  "What does done look like" sections are generated from it by a
  script (e.g. `render_board.py`) into one merged "Roadmap" section,
  never hand-edited. The up-next list stays first and always open, no
  fold, no scroll: it is the reason the page exists. The bug ledger
  lives on the same board, one `kind` column telling a bug row from a
  task row, and "Broken or open" renders from it the same way — open
  bugs first, fixed ones behind one fold.
- The working sections (verdict through bugs) should read in about
  three minutes. When the page grows past that, cut or move — a page
  the owner does not read organizes nobody.

## Rules learned the hard way

Keep this list growing. Each rule exists because a page broke without
it.

1. **When a milestone lands, sweep every place that states state in
   one pass** — verdict, grades, waiting-on-owner, next steps,
   roadmap, bugs. Updating only the section in front of you is how
   the page once said, simultaneously, that a verb passed, was
   blocked, and was still to be written.
2. **Never refer to anything by number or position.** "Checkpoints 3,
   8 and the PR gate" broke silently the day the list was reordered.
   Requirements live inside the item they apply to; references use
   names.
3. **One claim per checkbox.** A box holding two milestones can never
   be checked honestly, so it under-reports finished work.
4. **A phase is done when its checks pass, everything they found is
   fixed or has a written decision, and the suite itself has been
   reviewed.** First green is one third of done. A finding that just
   sits in a list keeps the phase open.
5. **Freshness is part of the contract.** A session that changed
   reality and did not update the page did not finish.
6. **One initiative, one page.** A second roadmap gets its own folder;
   the parent keeps one paragraph and a link.
7. **No dates on notes.** A checked box carries proof, not a date —
   the log and git carry time. Dates appear only where time is the
   content: log entries, run results.
8. **Blockers in flight are stated where the reader will look next**,
   and deleted the moment they clear.
9. **Voice drifts by imitation, so sweep it like state.** Sessions
   copy the style of neighboring lines, not the tone doc — the page
   collected "Conformance — passing but shallow (the tiles above
   carry the numbers)" this way. Before editing, reread
   `tone_and_taste.md`; when that doc gains a rule, sweep this page
   against it in the same pass.
10. **A number lives in one place, and a grade is a sentence.** The
    tile row duplicated the grades' numbers, which is how "the tiles
    above carry the numbers" got written. A stat appears once; each
    grade carries its own evidence; "Area — word" headings are
    banned — they train every later session to write fragments.

11. **A session that delegates to subagents watches them.** Start a
    watcher when the first subagent launches: every minute it compares
    the working repos (dirty files and HEAD commits), and when a full
    minute passes with no diff it tells the supervising session, which
    then decides whether to intervene. This exists because a stuck
    subagent looks exactly like a working one until someone checks —
    silence is not progress. The watcher also means each finished task
    shows up as its own commit, so the git log carries the trail of how
    things changed. Learned running it for a day:
    - A git-diff watcher is blind twice over: test runs write nothing
      until they end, and edits under gitignored folders (`writeup/`)
      never show. Before calling anything stuck, check the live signals
      in order — is the process alive (`pgrep`), is the suite's
      progress log advancing (`tests/.logs/<suite>-progress.log`), is
      the backend log's last line seconds old. A quiet minute with a
      fresh log line is a test running, not a stall.
    - Subagents park themselves on long processes ("waiting for the
      suite; I'll pick up when it fires") and nothing ever wakes them.
      Tell every delegated agent to wait in its own foreground; when
      one parks anyway, arm a one-shot notifier on the process ending
      (`until ! pgrep -f <it>; do sleep 15; done`) and resume the agent
      with the result when it fires.
    - Escalate by silence length, cheap checks first: at one quiet
      minute glance at processes; at three, check log freshness; at
      ten, the process should have hit its own timeout — investigate
      for real. Intervening at minute one wastes more than it saves.

12. **Parallelize delegated tasks by file overlap, not by board
    order.** A task board's dependency column says what must be true
    before a task's check can pass, but two tasks with no shared files
    can run at the same time even when the board lists one after the
    other. Before each fan-out, list the files each candidate task
    touches; tasks with disjoint file sets go out together, tasks that
    share a file run in sequence. This exists because a session once
    ran the measure_something removal after the dead-code deletion,
    although the two touched entirely different files and could have
    run together.

13. **The verdict and grades name things by what they do, not by their
    identifiers.** A grade built from tool flags, internal service
    names and commit hashes is written for the implementer; the owner
    reading cold called it "random jargon". Say "skill code cannot
    reach the internet — a test skill that tried an HTTP call failed",
    not the flag that enforces it. Identifiers — paths, flags,
    commands, hashes — belong in the log, the linked page, or the
    next-steps list (which agents execute); in a grade, at most one,
    and only when the reader must type it. One initiative's grade
    cells collected a dozen identifiers this way and had to be
    rewritten. (Phrasing standard for playbook entries themselves:
    `writing_playbook.md`.)

14. **One status vocabulary for the whole page.** The checkboxes say
    done/open, the pills say open/fixed/worked-around — and the grades
    must speak the same small set (done, open, blocked), one word per
    area of the plan. A page once gave each grade its own fresh
    adjective (built, safe, live, waiting); every new word was one
    more thing the reader had to decode, and the owner said so. A new
    status word may only be added when no existing one is honest, and
    then it joins the page's single set everywhere.

15. **Finished work never sits under a next-actions heading, even
    relabeled.** A completed task was rewritten in place to say "is
    done" and left at the top of Next actions — true, but the wrong
    shape: the fix was moving it out of that section entirely, not
    rewording it. A heading's meaning is what belongs under it, not
    just the words inside each item.

## Starting a new initiative

1. Make `writeup/<initiative>/` with the three files.
2. Reuse the CSS from the current test-framework page — tokens,
   checklist, table and details styles, light and dark, no build step.
3. First log entry: what was agreed, confidence, known risks.
