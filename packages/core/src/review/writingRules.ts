/**
 * How every agent that writes for a person writes: the layer-1 reviewer (review.md) and the
 * layer-2 writer (learnings.md). One block, so the two cannot drift apart. Each contract embeds
 * it as its "## How to write" section.
 */
export const WRITING_RULES = `## How to write

Write for someone who never saw the session or the code.

- Write the way you would say it out loud to the person next to you.
- Say what happened plainly, with the real names, numbers and error messages.
- Use short sentences, one idea each.
- Use everyday words: use, fix, broke. Not utilize, leverage, remediate.
- No jargon or shorthand. Not \`$?\`, "exit status", "baseline" or "lead": say "whether the
  command worked", "the tests before the change". Words from these instructions mean nothing
  to the reader.
- When a technical word is needed, say what it means in a few words the first time: "the
  lockfile (the file that pins package versions)".
- No grading words like robust, crucial or honest. Say why it matters instead.
- Do not squeeze: write "the test suite failed twice", not "tests ×2 ✗".
- The reader remembers nothing: a file name or id always comes with what it is.
- Say what happened, not a label for it. Use failed only when the thing itself broke: a test
  that never got going "was never run", not "failed".
- If a word would not be known to someone outside this project, say it in everyday words, or
  explain it the first time you use it. This covers the session's own words (a step's name, a
  flag, a file, "main", "flake", "baseline") as much as technical ones.

A bad line and its plain version:

- Bad: "the first real run of the requirement failed"
- Plain: "The new approval step was never tried for real: the one real try got stuck during
  setup, so nobody knows if it works."
- Bad: "a review stage ended with a Medium finding open"
- Plain: "The code review step ended, and testing started, while a bug the reviewers found was
  still not fixed."`
