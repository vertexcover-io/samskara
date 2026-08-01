import { execFile } from "node:child_process"
import { promisify } from "node:util"
import type { ProjectIdentity } from "@samskara/core"
import { resolveProject } from "./watcher/resolveProject.js"
import { type ResolvedRepo, createRepoResolver, resolveHeadSha } from "./watcher/resolveRepo.js"

const execFileAsync = promisify(execFile)

export const runGit = async (args: ReadonlyArray<string>, cwd: string): Promise<string | null> => {
  try {
    const { stdout } = await execFileAsync("git", [...args], { cwd })
    return stdout.trim()
  } catch {
    return null
  }
}

export const resolveLocalProject = (path: string): Promise<ProjectIdentity> =>
  resolveProject(path, { runGit })

export const createLocalRepoResolver = (): ((cwd: string) => Promise<ResolvedRepo | null>) =>
  createRepoResolver({ runGit })

export const resolveLocalHeadSha = (cwd: string): Promise<string | null> =>
  resolveHeadSha(cwd, { runGit })
