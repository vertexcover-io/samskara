import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "vitest"
import { runGitOrNull } from "./git.js"

const gone = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "samskara-git-gone-"))
  await rm(dir, { recursive: true, force: true })
  return dir
}

describe("runGitOrNull", () => {
  test("a working directory that no longer exists answers null rather than throwing", async () => {
    const cwd = await gone()

    await expect(
      runGitOrNull(["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd),
    ).resolves.toBeNull()
  })

  test("a directory outside any repo still answers null", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "samskara-git-bare-"))

    await expect(runGitOrNull(["config", "--get", "remote.origin.url"], cwd)).resolves.toBeNull()

    await rm(cwd, { recursive: true, force: true })
  })

  test("a real repo answers with git's output", async () => {
    const root = await runGitOrNull(
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      process.cwd(),
    )

    expect(root).toContain(".git")
  })
})
