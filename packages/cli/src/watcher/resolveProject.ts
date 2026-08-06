import { realpath } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import type { ProjectIdentity } from "@samskara/core"
import { runGitOrNull } from "../git.js"

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

/**
 * The **common** dir's parent, so a linked worktree resolves to its main checkout rather than
 * to a repo of its own. Null when the directory is not inside a git repo at all.
 */
export const gitRootOf = async (startDir: string): Promise<string | null> => {
  const commonDir = await runGitOrNull(
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    startDir,
  )
  return commonDir ? dirname(resolve(commonDir)) : null
}

/**
 * One canonical form for the whole identity: absolute, normalized, and symlink-resolved. Every
 * consumer -- containment, `relative()`, the slug -- reads the same string, so nothing downstream
 * re-resolves and no two of them can disagree. `realpath` throws on a path that does not exist,
 * which leaves the normalized form as the answer.
 */
export const resolveProject = async (startDir: string): Promise<ProjectIdentity> => {
  const declared = (await gitRootOf(startDir)) ?? resolve(startDir)
  const root = await realpath(declared).catch(() => declared)
  const remote = await runGitOrNull(["config", "--get", "remote.origin.url"], root)
  const parsed = remote ? parseRemote(remote) : null
  if (parsed) {
    return { name: parsed.repoName, slug: `${parsed.owner}-${parsed.repoName}`, root }
  }

  return { name: basename(root), slug: slugFromDir(root), root }
}
