import { describe, expect, test } from "vitest"
import { pullRequestFlags } from "./gitCommands.js"

describe("pullRequestFlags", () => {
  test("reads the title, base and head a PR was opened with", () => {
    expect(
      pullRequestFlags(
        'gh pr create --base master --head feat/tabs --title "Show commits and PRs" --body "short"',
      ),
    ).toEqual({ title: "Show commits and PRs", baseBranch: "master", headBranch: "feat/tabs" })
  })

  // The body is one quoted argument however many lines it spans, and PR bodies discuss flags.
  // Scanning the raw string for `--base` would read the prose as the invocation.
  test("a flag named inside the body is prose, not an invocation", () => {
    const command = [
      "gh pr create --base master --head feat/x --title 'Real title'",
      `--body "$(cat <<'EOF'`,
      'The old call passed --base develop --title "Wrong" and we changed it.',
      "EOF",
      ')"',
    ].join("\n")

    expect(pullRequestFlags(command)).toEqual({
      title: "Real title",
      baseBranch: "master",
      headBranch: "feat/x",
    })
  })

  test("equals form is the same invocation as the spaced form", () => {
    expect(pullRequestFlags('gh pr create --base=main --title="With equals"')).toEqual({
      title: "With equals",
      baseBranch: "main",
    })
  })

  test("an escaped quote stays inside the title rather than ending it", () => {
    expect(pullRequestFlags('gh pr create --title "Fix the \\"broken\\" tab" --base main')).toEqual(
      {
        title: 'Fix the "broken" tab',
        baseBranch: "main",
      },
    )
  })

  test("a flag given no value claims none, rather than swallowing the next flag", () => {
    expect(pullRequestFlags("gh pr create --title --base main")).toEqual({ baseBranch: "main" })
  })

  test("a bare invocation carries nothing, which is not the same as carrying blanks", () => {
    expect(pullRequestFlags("gh pr create")).toEqual({})
  })
})
