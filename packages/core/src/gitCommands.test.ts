import { describe, expect, test } from "vitest"
import { pullRequestFlags } from "./gitCommands.js"

const bodyNamingFlags = [
  "gh pr create --base master --head feat/x --title 'Real title'",
  `--body "$(cat <<'EOF'`,
  'The old call passed --base develop --title "Wrong" and we changed it.',
  "EOF",
  ')"',
].join("\n")

describe("pullRequestFlags", () => {
  test.each([
    {
      label: "reads the title, base and head a PR was opened with",
      command:
        'gh pr create --base master --head feat/tabs --title "Show commits and PRs" --body "short"',
      flags: { title: "Show commits and PRs", baseBranch: "master", headBranch: "feat/tabs" },
    },
    {
      label: "a flag named inside a multi-line quoted body is prose, not an invocation",
      command: bodyNamingFlags,
      flags: { title: "Real title", baseBranch: "master", headBranch: "feat/x" },
    },
    {
      label: "equals form is the same invocation as the spaced form",
      command: 'gh pr create --base=main --title="With equals"',
      flags: { title: "With equals", baseBranch: "main" },
    },
    {
      label: "an escaped quote stays inside the title rather than ending it",
      command: 'gh pr create --title "Fix the \\"broken\\" tab" --base main',
      flags: { title: 'Fix the "broken" tab', baseBranch: "main" },
    },
    {
      label: "a flag given no value claims none, rather than swallowing the next flag",
      command: "gh pr create --title --base main",
      flags: { baseBranch: "main" },
    },
    {
      label: "a bare invocation carries nothing, which is not the same as carrying blanks",
      command: "gh pr create",
      flags: {},
    },
  ])("$label", ({ command, flags }) => {
    expect(pullRequestFlags(command)).toEqual(flags)
  })
})
