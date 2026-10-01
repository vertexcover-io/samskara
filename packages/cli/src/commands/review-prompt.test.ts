import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BASE_REVIEW_INSTRUCTIONS, type HarnessRunner } from "@samskara/core"
import { beforeEach, describe, expect, test } from "vitest"
import { resolveReviewInstructions } from "./review-prompt.js"

const quiet = { write: () => undefined }

/** A merge agent that writes MERGED.md from what it was given, and counts its runs. */
const mergeAgent = () => {
  const calls: string[] = []
  const runner: HarnessRunner = {
    run: async ({ workspaceDir }) => {
      const user = await readFile(join(workspaceDir, "USER.md"), "utf8")
      calls.push(user)
      await writeFile(
        join(workspaceDir, "MERGED.md"),
        `# How to review\n\nmerged: ${user.trim()}\n`,
      )
      await writeFile(join(workspaceDir, "CHANGES.md"), "- Added to Step 1: port check\n")
      return { stdout: "merged", firstByteMs: 5 }
    },
  }
  return { runner, calls }
}

describe("resolveReviewInstructions", () => {
  let dir: string
  let configDir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "samskara-review-prompt-"))
    configDir = join(dir, "config")
  })

  const resolve = (prompt: string | false | undefined, runner?: HarnessRunner) =>
    resolveReviewInstructions({
      prompt,
      cwd: dir,
      configDir,
      stderr: quiet,
      createRunner: () => runner ?? mergeAgent().runner,
    })

  test("RP1: no prompt and nothing saved uses the base", async () => {
    const result = await resolve(undefined)
    expect(result).toMatchObject({ kind: "ready", source: "base" })
    if (result.kind === "ready") expect(result.instructions).toBe(BASE_REVIEW_INSTRUCTIONS)
  })

  test("RP2: --prompt naming a file that does not exist is an error, not a silent default", async () => {
    const result = await resolve("my-system.md")
    expect(result).toEqual({
      kind: "error",
      message: `No prompt file at ${join(dir, "my-system.md")}.`,
    })
  })

  test("RP3: an empty prompt file is refused, not merged", async () => {
    await writeFile(join(dir, "my-system.md"), "  \n")
    const result = await resolve("my-system.md")
    expect(result).toMatchObject({ kind: "error" })
    if (result.kind === "error") expect(result.message).toContain("is empty")
  })

  test("RP4: a filled prompt is merged once, saved as the default, then reused without merging", async () => {
    await writeFile(join(dir, "my-system.md"), "Always check the port.\n")
    const agent = mergeAgent()
    const first = await resolve("my-system.md", agent.runner)
    expect(first).toMatchObject({
      kind: "ready",
      source: "merged",
      changes: "- Added to Step 1: port check",
    })
    if (first.kind === "ready")
      expect(first.instructions).toContain("merged: Always check the port.")

    const second = await resolve(undefined, agent.runner)
    expect(second).toMatchObject({ kind: "ready", source: "saved" })
    if (second.kind === "ready")
      expect(second.instructions).toContain("merged: Always check the port.")
    expect(agent.calls).toHaveLength(1)
  })

  test("RP5: editing the saved prompt merges again on the next run", async () => {
    await writeFile(join(dir, "my-system.md"), "Always check the port.\n")
    const agent = mergeAgent()
    await resolve("my-system.md", agent.runner)
    await writeFile(join(dir, "my-system.md"), "Always check the port and the seed data.\n")
    const again = await resolve(undefined, agent.runner)
    expect(again).toMatchObject({ kind: "ready", source: "merged" })
    expect(agent.calls).toHaveLength(2)
  })

  test("RP6: --no-prompt uses the base for this run and keeps the saved default", async () => {
    await writeFile(join(dir, "my-system.md"), "Always check the port.\n")
    const agent = mergeAgent()
    await resolve("my-system.md", agent.runner)
    expect(await resolve(false, agent.runner)).toMatchObject({ kind: "ready", source: "base" })
    expect(await resolve(undefined, agent.runner)).toMatchObject({ kind: "ready", source: "saved" })
  })

  test("RP7: a merge agent that writes nothing is an error, and nothing is saved", async () => {
    await writeFile(join(dir, "my-system.md"), "Always check the port.\n")
    const silent: HarnessRunner = { run: async () => ({ stdout: "", firstByteMs: null }) }
    const result = await resolve("my-system.md", silent)
    expect(result).toMatchObject({ kind: "error" })
    expect(await resolve(undefined)).toMatchObject({ kind: "ready", source: "base" })
  })
})
