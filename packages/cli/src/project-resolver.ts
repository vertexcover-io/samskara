import { execFile } from "node:child_process"
import { promisify } from "node:util"
import type { ProjectIdentity } from "@samskara/core"
import { resolveProject } from "./watcher/resolveProject.js"

const execFileAsync = promisify(execFile)

const runGit = async (args: ReadonlyArray<string>, cwd: string): Promise<string | null> => {
  try {
    const { stdout } = await execFileAsync("git", [...args], { cwd })
    return stdout.trim()
  } catch {
    return null
  }
}

export const resolveLocalProject = (path: string): Promise<ProjectIdentity> =>
  resolveProject(path, { runGit })
