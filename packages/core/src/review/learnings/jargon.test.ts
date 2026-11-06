import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "vitest"
import { projectWords } from "./jargon.js"

const withHarness = async (paths: ReadonlyArray<string>, check: (dir: string) => Promise<void>) => {
  const dir = mkdtempSync(join(tmpdir(), "jargon-"))
  try {
    for (const path of paths) {
      mkdirSync(join(dir, path, ".."), { recursive: true })
      writeFileSync(join(dir, path), "x\n")
    }
    await check(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test("SC201: project words are yok, harness, the harness's name and each skill, agent, hook and command name that is not an everyday word", async () => {
  await withHarness(
    [
      "skills/code-review/SKILL.md",
      "skills/fix/SKILL.md",
      "skills/orchestrate/SKILL.md",
      "agents/planner.md",
      "hooks/stop-guard.sh",
      "commands/ship.md",
      "docs/guide.md",
      "node_modules/skills/x/SKILL.md",
    ],
    async (dir) => {
      expect(await projectWords(dir, "my-harness")).toEqual([
        "code-review",
        "harness",
        "my-harness",
        "orchestrate",
        "planner",
        "ship",
        "stop-guard",
        "yok",
      ])
    },
  )
})

test("defects-1: names come from the top-level skills, agents, hooks and commands folders and their .claude, .codex and .agents copies, never from a nested source folder such as packages/core/src/agents", async () => {
  await withHarness(
    [
      "packages/core/src/agents/common.ts",
      "packages/core/src/hooks/index.ts",
      "packages/core/src/agents/fixtures/a.json",
      ".claude/skills/tdd/SKILL.md",
      ".codex/agents/reviewer.toml",
      ".agents/skills/qa/SKILL.md",
    ],
    async (dir) => {
      expect(await projectWords(dir)).toEqual(["harness", "qa", "reviewer", "tdd", "yok"])
    },
  )
})

test("spec-2: test files and type declarations in a named folder give no names, and worker is an everyday word, while a real hook name such as pre-tool-use stays banned", async () => {
  await withHarness(
    [
      "hooks/proof-report-template.test.mjs",
      "hooks/pre-tool-use.sh",
      "agents/types.d.ts",
      ".codex/agents/worker.toml",
    ],
    async (dir) => {
      expect(await projectWords(dir)).toEqual(["harness", "pre-tool-use", "yok"])
    },
  )
})
