import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

/**
 * Null on any failure -- git absent, cwd gone, a non-zero exit. Callers decide what an unanswered
 * question means for them; none of them can do anything useful with the error itself.
 */
export const runGit = async (args: ReadonlyArray<string>, cwd: string): Promise<string | null> => {
  try {
    const { stdout } = await execFileAsync("git", [...args], { cwd })
    return stdout.trim()
  } catch {
    return null
  }
}
