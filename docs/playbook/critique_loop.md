# The critique loop: how an artifact gets good

What turned the test dashboard from unusable to useful was not more
building — it was a loop: a harsh reviewer, a work order, an implementer,
a re-rating. Use it on any artifact a person consumes (a page, a doc, a
CLI's output).

## The loop

1. **Critique.** One agent reads the artifact's contracts first (its
   lens or pattern doc, `tone_and_taste.md`), then the artifact, and
   rates it 1-10 on named fronts — usefulness weighted most. Every
   deduction needs evidence and a concrete fix. The output is a work
   order, not an opinion.
2. **Implement.** A second agent treats the critique as required work,
   item by item, and verifies each fix against the rendered artifact,
   not the code.
3. **Re-rate** with the same standard. Under 9 on any front means
   another round with only the remaining deductions.

## The rules that make it compound

- **Every correction becomes a rule.** When the user or the critic finds
  a class of failure ("counting instead of meaning", "the page explains
  in its own voice", "a state word standing alone"), the fix is applied
  AND the rule is written into the artifact's contract doc in the same
  pass. The artifact gets better once; the contract gets better forever.
- **Contracts before artifacts.** The critic reads the lens/pattern doc
  first, so it judges against what we agreed, not taste of the day. If
  the critic disagrees with the contract, that is a finding about the
  contract, raised separately.
- **The user's spot-checks are findings too.** A one-line complaint in
  chat ("this looks biased") is treated exactly like a critic finding:
  fix, then rule, same pass.

## Where the contracts live

- Test dashboard: `docs/tests/lens.md`
- Mission-control pages: `docs/playbook/mission-control/README.md`
- Everything's voice and look: `docs/playbook/tone_and_taste.md`
