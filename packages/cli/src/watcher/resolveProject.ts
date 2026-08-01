import { dirname, resolve, win32 } from "node:path"
import type { ProjectIdentity } from "@samskara/core"

export type GitRunner = (args: ReadonlyArray<string>, cwd: string) => Promise<string | null>

export type ResolveProjectDeps = {
  readonly runGit: GitRunner
}

export type ParsedRemote = {
  readonly host: string
  readonly owner: string
  readonly repoName: string
}

export const parseRemote = (url: string): ParsedRemote | null => {
  const cleaned = url.trim().replace(/\.git$/, "")
  const ssh = cleaned.match(/^git@([^:]+):([^/]+)\/(.+)$/)
  if (ssh?.[1] && ssh[2] && ssh[3]) return { host: ssh[1], owner: ssh[2], repoName: ssh[3] }
  const https = cleaned.match(/^https?:\/\/([^/]+)\/([^/]+)\/(.+)$/)
  if (https?.[1] && https[2] && https[3])
    return { host: https[1], owner: https[2], repoName: https[3] }
  return null
}

// Blanket-replace both `/` and `\` so the slug is stable cross-platform.
const slugFromDir = (dir: string): string => dir.replace(/[/\\]/g, "-")

export const basename = (dir: string): string => {
  const segments = dir.split(/[/\\]/).filter((s) => s.length > 0)
  return segments[segments.length - 1] ?? dir
}

const isWindowsPath = (path: string): boolean => /^[A-Za-z]:[\\/]/.test(path)
const normalizedAbsolutePath = (path: string): string =>
  isWindowsPath(path) ? win32.normalize(path) : resolve(path)
const parentDirectory = (path: string): string =>
  isWindowsPath(path) ? win32.dirname(path) : dirname(path)

/**
 * The **common** dir's parent, so a linked worktree resolves to its main checkout rather than
 * to a repo of its own. Null when the directory is not inside a git repo at all.
 */
export const gitRootOf = async (startDir: string, runGit: GitRunner): Promise<string | null> => {
  const commonDir = await runGit(
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    startDir,
  )
  return commonDir ? parentDirectory(normalizedAbsolutePath(commonDir)) : null
}

export const resolveProject = async (
  startDir: string,
  { runGit }: ResolveProjectDeps,
): Promise<ProjectIdentity> => {
  const projectRoot = (await gitRootOf(startDir, runGit)) ?? normalizedAbsolutePath(startDir)
  const remote = await runGit(["config", "--get", "remote.origin.url"], projectRoot)
  const parsed = remote ? parseRemote(remote) : null
  if (parsed) {
    return {
      name: parsed.repoName,
      slug: `${parsed.owner}-${parsed.repoName}`,
      root: projectRoot,
    }
  }

  return {
    name: basename(projectRoot),
    slug: slugFromDir(projectRoot),
    root: projectRoot,
  }
}
