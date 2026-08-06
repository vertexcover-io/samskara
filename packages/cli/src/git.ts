import { execFile } from "node:child_process"
import { promisify } from "node:util"
import type pino from "pino"

const execFileAsync = promisify(execFile)

export const runGit = async (args: ReadonlyArray<string>, cwd: string): Promise<string> => {
  const { stdout } = await execFileAsync("git", [...args], { cwd })
  return stdout.trim()
}

/**
 * Null covers a git that ran and refused, which several callers treat as a plain "no" -- a repo
 * with no remote exits 1, one outside a work tree exits 128. A missing binary still throws: that
 * answers nobody's question and would otherwise look like every repo lacking every property.
 *
 * 128 is git's generic fatal, so the code alone never says *why* it refused. Callers that need to
 * tell "not a repo" from "this repo would not answer" have to ask a question that succeeds.
 */
export const runGitOrNull = async (
  args: ReadonlyArray<string>,
  cwd: string,
  log?: pino.Logger,
): Promise<string | null> => {
  try {
    return await runGit(args, cwd)
  } catch (error) {
    const { code, stderr } = error as { code?: number | string; stderr?: string }
    if (code === "ENOENT") throw error
    log?.debug({ args, cwd, code, stderr: stderr?.trim() }, "git command failed")
    return null
  }
}
