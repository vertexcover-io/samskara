# Tenets

Standing rules for how this platform is built and operated. When a change
conflicts with a tenet, the change is wrong or the tenet gets amended
here, in the same PR, explicitly.

1. **Every feature works the same way in every environment.** No code
   path that exists for one machine, one NODE_ENV, or one runner. The
   pm2-vs-dev.sh split taught us this: a bug lived for days because two
   environments ran different branches of the same code.

2. **One source of truth for any config or data.** A value defined twice
   will disagree eventually. Env files own configuration; nothing
   overrides them silently.

3. **Documentation lives in `docs/`, not inline.** No inline docs or
   docstrings that duplicate what a doc says. One deliberate exception,
   named here so it is not drift: a test's docstring is data, not
   documentation — the test dashboard reads it as the test's
   plain-English description, and it lives with the test because it must
   change in the same edit as the assertions. It describes only what
   that one test checks, never how the system works.

4. **Skills are not tied to one agent tool.** Skills live in
   `.claude/skills/` and are written tool-agnostically: the file names a
   workflow any agent — or a person — can follow, without depending on
   one harness's machinery.

5. **The same error must not happen more than three times.** If it
   does, capturing it in `docs/` is mandatory, not optional — a guide,
   a gotcha note, or a script that makes the error impossible.

6. **Patch root causes, not symptoms.** If the root cause is deeper than
   the code in front of you, go to first principles. A symptom patch is
   acceptable only as a stopgap, recorded as an open bug pointing at the
   root cause.

7. **Everything a human can do in the UI has a 1-to-1 CLI path.** Agents
   and scripts operate the platform the same way people do, with no
   second-class paths.

8. **Production boundaries are guarded by infrastructure, not by agent
   discipline.** Real instruments sit behind network isolation (VPN), so
   no misconfigured agent or test can reach them by accident. Agent-side
   guardrails (like the production confirm flag) are a second layer,
   never the only one. Today this is aspirational — the VPN boundary is
   not built — so the confirm flag is currently the only gate, and that
   is a known gap, not the design.

9. **No verb developer needs database write access.** Raw SQL, database
   CLIs and GUI clients are discouraged for everyday work. Where tests
   or operations need state, we build reusable tools and scripts, and
   document them at the repo root. Tests read state only through the API
   or the ORM-backed CLI family (`oss-nodejs-custom/src/database/
   commands/`, e.g. `npm run run:evidence`); when a needed read has no
   tool, the fix is to extend that family — never to write SQL in test
   code. Schema knowledge lives in the entities, nowhere else. One named
   exception: the preflight suite (`tests/preflight/`) queries mysql
   directly, because its job is to verify the database layer before the
   ORM-backed tools above it can be trusted.

10. **LLM cost is a passive tenet: always on, never asked for.** Token
    spend is engineering cost like any other. In practice: commands run
    with quiet flags and filtered output (`tail`, `grep`, counts) — never
    dump raw logs or full files into a context when three lines answer
    the question; polling is a wait-until check that prints one line at
    the end, not a loop of full status dumps; scripts print a one-line
    outcome by default and keep detail behind a flag; agent briefs point
    at docs instead of inlining them; and the model tier matches the task
    (see CLAUDE.md on delegation). An agent that reads 100 lines to use
    3 should have asked for the 3.

11. **Everything the UI shows is explainable and self-sufficient.** A
    reader with the page open and nothing else must be able to answer,
    from the page alone: what does this state mean, where did it come
    from, and what happens next. Every status word carries its
    consequence beside it (what Accept does, where an accepted lesson
    goes), every count says what it counts, and data whose provenance
    would surprise the reader (test fixtures, seed rows) never shares a
    view with real data. If a label needs a teammate or a doc beside the
    screen to be understood, the label is wrong — fix the page, not the
    reader.

12. **No command touches `/dev`.** Discarding output is what redirection is
    for (`> /dev/null` is a shell redirect, not a file operation on a
    device node); truncating or clearing a file is `rm` or the write tools,
    never `cp /dev/null ...` or copying anything *to* `/dev/...`. Device
    nodes are not scratch space, and a command that names them has already
    stopped saying what it does.
