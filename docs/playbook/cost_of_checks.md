# The cost of checks

Our docs price correctness everywhere (gates, proofs, checks) and
wall-clock time nowhere, so an agent reading them complies with the
ritual instead of questioning it. This page is the other half of the
ledger: when a check is worth its minutes, and when running it again is
just repeating the ritual.

**Judgement decides what runs — there is no fixed pipeline.** Don't run
checks on a schedule ("subset per step, full run at done") the way a CI
job would; look at the actual change and decide what could break, then
run the cheapest thing that would show it. A comment fix needs a grep.
A change inside one module needs that module's tests. A change to code
every run goes through, or one whose reach you're unsure of, needs the
full end-to-end run — and when several changes are waiting on that, one
run closes them all. Two things keep the judgement honest: say what you
chose not to run and why, and stay humble about guessing reach — a
comment here once claimed its module made one state change while its
helpers made five, and hidden database columns once made a whole
processing step silently skip. When the change is tangled or the last
surprise was recent, judgement says run wide; when the change is
plainly contained, it says don't.

**One gate per batch.** Cheap checks — one test file, a unit-test run,
a build — run after every change. Expensive checks — a full end-to-end
suite, a before/after audit — cover a batch of changes at once, not
each one. One session ran a full audit on a cleanup step minutes after
the previous audit had already passed on the same code; one batch, one
gate would have halved the runs.

**Read before you run.** Before an expensive check, spend a few minutes
reading the code for the bug class the check would catch — trace every
state mutation, including inside helper services, and never trust a
comment's claim about what the code does. In one session, reading found
three of four bugs; the fourth cost a 35-minute audit, because the
reading pass had trusted a comment that said "this is the only
mutation."

**A repeated expensive run is a smell, not diligence.** The second time
the same long check runs in one session, stop and ask what would have
made the first run sufficient, instead of running it again.

**Question the recipe, not just the step.** When a doc prescribes a
sequence, the sequence's cost is part of the decision. If following it
means an idle wait or a duplicate run, say so and adapt — the docs
record what worked once, not what is optimal forever.

**A fresh perspective is cheap.** A reviewer agent given a clean framing
can find in two minutes what a session's own groove has stopped seeing;
asking "why are we running this again?" does the same. When a session
notices it is repeating a workflow, hand the question "is this workflow
itself wrong?" to a fresh agent rather than repeating the workflow again
to find out.

**Scope the check to what the change can reach.** A change inside one
module is cleared by that module's runs (the initiative's audit tooling
usually takes a scoping flag and finishes in a couple of minutes); only
a change to shared code — anything every run exercises — earns the full
sweep. Running everything for a one-module fix buys no extra proof,
only extra minutes. How to scope a given initiative's checks is that
initiative's detail: its `RESUME.md` names the commands.
