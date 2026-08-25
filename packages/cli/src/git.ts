import { execFile } from "node:child_process"
import { stat } from "node:fs/promises"
import { promisify } from "node:util"
import type pino from "pino"

const execFileAsync = promisify(execFile)

export const runGit = async (args: ReadonlyArray<string>, cwd: string): Promise<string> => {
  const { stdout } = await execFileAsync("git", [...args], { cwd })
  return stdout.trim()
}

const isDirectory = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/**
 * Null covers a git that ran and refused, which several callers treat as a plain "no" -- a repo
 * with no remote exits 1, one outside a work tree exits 128. A missing binary still throws: that
 * answers nobody's question and would otherwise look like every repo lacking every property.
 *
 * 128 is git's generic fatal, so the code alone never says *why* it refused. Callers that need to
 * tell "not a repo" from "this repo would not answer" have to ask a question that succeeds.
 *
 * A `cwd` that no longer exists -- a deleted worktree named by an old session -- fails the spawn
 * itself with the same ENOENT, naming `git` as the missing path. Only the directory tells them
 * apart, and a directory that is gone is a plain "no": rethrowing it aborts the whole watch cycle,
 * which then never writes its checkpoints and resends every session forever.
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
    if (code === "ENOENT") {
      if (await isDirectory(cwd)) throw error
      log?.debug({ args, cwd }, "git skipped: working directory no longer exists")
      return null
    }
    log?.debug({ args, cwd, code, stderr: stderr?.trim() }, "git command failed")
    return null
  }
}
