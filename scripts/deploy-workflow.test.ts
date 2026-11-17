import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const WORKFLOW = readFileSync(
  join(import.meta.dir, "..", ".github", "workflows", "deploy.yml"),
  "utf8",
)

/** The Deploy step's text, from its name to the next step. */
const deployStep = (): string => {
  const start = WORKFLOW.indexOf("- name: Deploy\n")
  const next = WORKFLOW.indexOf("- name:", start + 1)
  return WORKFLOW.slice(start, next < 0 ? undefined : next)
}

/** The secret names the step's jq program copies from its environment into the server's env. */
const copiedSecrets = (step: string): ReadonlyArray<string> =>
  (/\$ENV \| \{([^}]*)\}/.exec(step)?.[1] ?? "").split(",").map((key) => key.trim())

describe("deploy workflow", () => {
  test("SC20: the Deploy step writes LEARNINGS_HARNESS_GITHUB_TOKEN to the server's env", () => {
    const step = deployStep()

    expect(step).toMatch(
      /\n\s+LEARNINGS_HARNESS_GITHUB_TOKEN: \$\{\{ secrets\.LEARNINGS_HARNESS_GITHUB_TOKEN \}\}\n/,
    )
    expect(copiedSecrets(step)).toEqual([
      "CLAUDE_CODE_OAUTH_TOKEN",
      "ANTHROPIC_API_KEY",
      "OPENCODE_API_KEY",
      "LEARNINGS_HARNESS_GITHUB_TOKEN",
    ])
  })
})
