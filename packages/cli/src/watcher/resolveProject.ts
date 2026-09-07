import { realpath, stat } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import type { ProjectIdentity } from "@samskara/core"
import { runGitOrNull } from "../git.js"
import { canonicalSshHost } from "../ssh.js"

export type ParsedRemote = {
  readonly host: string
  readonly owner: string
  readonly repoName: string
}

const SSH_REMOTE = /^git@([^:]+):([^/]+)\/(.+)$/
const HTTPS_REMOTE = /^https?:\/\/([^/]+)\/([^/]+)\/(.+)$/

const clean = (url: string): string => url.trim().replace(/\.git$/, "")

export const parseRemote = (url: string): ParsedRemote | null => {
  const cleaned = clean(url)
  const ssh = cleaned.match(SSH_REMOTE)
  if (ssh?.[1] && ssh[2] && ssh[3]) return { host: ssh[1], owner: ssh[2], repoName: ssh[3] }
  const https = cleaned.match(HTTPS_REMOTE)
  if (https?.[1] && https[2] && https[3])
    return { host: https[1], owner: https[2], repoName: https[3] }
  return null
}

/**
 * The host an ssh url names is whatever `~/.ssh/config` says it is, so it is asked -- see
 * `canonicalSshHost`, which rejects rather than guess when ssh cannot answer. An https url already
 * carries a real host and is left alone: ssh config has no say over it, and resolving one would
 * let a stray `Host` entry rewrite it.
 */
export const resolveRemote = async (url: string): Promise<ParsedRemote | null> => {
  const parsed = parseRemote(url)
  if (parsed === null || !SSH_REMOTE.test(clean(url))) return parsed
  return { ...parsed, host: await canonicalSshHost(parsed.host) }
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
 * re-resolves and no two of them can disagree.
 *
 * Null when the directory is not there. Git cannot run in a folder that is gone -- a removed
 * worktree, a deleted checkout -- and the path-derived fallback below would then mint a slug for
 * it that matches no project, which every caller reads as "capture is off" rather than "this
 * cannot be identified". The fallback is still right for a directory that exists without being a
 * git repo, so it stays; it just needs the directory to be real.
 */
export const resolveProject = async (startDir: string): Promise<ProjectIdentity | null> => {
  const live = await stat(startDir).then(
    (entry) => entry.isDirectory(),
    () => false,
  )
  if (!live) return null

  const declared = (await gitRootOf(startDir)) ?? resolve(startDir)
  const root = await realpath(declared).catch(() => declared)
  const remote = await runGitOrNull(["config", "--get", "remote.origin.url"], root)
  const parsed = remote ? await resolveRemote(remote).catch(() => parseRemote(remote)) : null
  if (parsed) {
    const { host, owner, repoName } = parsed
    return { name: repoName, slug: `${owner}-${repoName}`, root, remote: { host, owner, repoName } }
  }

  return { name: basename(root), slug: slugFromDir(root), root }
}
