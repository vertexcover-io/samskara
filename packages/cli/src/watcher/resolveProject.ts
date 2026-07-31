import { dirname, resolve, win32 } from "node:path"
import type { ProjectIdentity } from "@samskara/core"

export type GitRunner = (args: ReadonlyArray<string>, cwd: string) => Promise<string | null>

export type ResolveProjectDeps = {
  readonly runGit: GitRunner
}

const parseRemote = (url: string): { readonly owner: string; readonly repoName: string } | null => {
  const cleaned = url.trim().replace(/\.git$/, "")
  const ssh = cleaned.match(/^git@[^:]+:([^/]+)\/(.+)$/)
  if (ssh?.[1] && ssh[2]) return { owner: ssh[1], repoName: ssh[2] }
  const https = cleaned.match(/^https?:\/\/[^/]+\/([^/]+)\/(.+)$/)
  if (https?.[1] && https[2]) return { owner: https[1], repoName: https[2] }
  return null
}

// Blanket-replace both `/` and `\` so the slug is stable cross-platform.
const slugFromDir = (dir: string): string => dir.replace(/[/\\]/g, "-")

const basename = (dir: string): string => {
  const segments = dir.split(/[/\\]/).filter((s) => s.length > 0)
  return segments[segments.length - 1] ?? dir
}

const isWindowsPath = (path: string): boolean => /^[A-Za-z]:[\\/]/.test(path)
const normalizedAbsolutePath = (path: string): string =>
  isWindowsPath(path) ? win32.normalize(path) : resolve(path)
const parentDirectory = (path: string): string =>
  isWindowsPath(path) ? win32.dirname(path) : dirname(path)

export const resolveProject = async (
  startDir: string,
  { runGit }: ResolveProjectDeps,
): Promise<ProjectIdentity> => {
  const commonDir = await runGit(
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    startDir,
  )
  const projectRoot = commonDir
    ? parentDirectory(normalizedAbsolutePath(commonDir))
    : normalizedAbsolutePath(startDir)
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
