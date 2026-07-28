import type { RepoIdentity } from "@samskara/core"
import { type GitRunner, basename, gitRootOf, parseRemote } from "./resolveProject.js"

export type ResolvedRepo = RepoIdentity & { readonly root: string }

export type ResolveRepoDeps = { readonly runGit: GitRunner }

/**
 * A repo with no remote still needs a stable identity, so its root stands in for the remote.
 * `host: "local"` keeps it from colliding with a remote-backed repo of the same basename.
 */
const LOCAL_HOST = "local"

const identityFor = async (cwd: string, runGit: GitRunner): Promise<ResolvedRepo | null> => {
  const root = await gitRootOf(cwd, runGit)
  if (root === null) return null
  const remote = await runGit(["config", "--get", "remote.origin.url"], root)
  const parsed = remote ? parseRemote(remote) : null
  if (parsed) return { ...parsed, ownerType: "org", root }
  return { host: LOCAL_HOST, owner: root, ownerType: "org", repoName: basename(root), root }
}

/**
 * Deliberately uncached and never folded into `createRepoResolver`: HEAD moves on every commit,
 * checkout and rebase, so it is only correct at the moment a session starts. The watcher polls
 * after the fact, so a later read returns a sha the session never ran on.
 */
export const resolveHeadSha = (cwd: string, { runGit }: ResolveRepoDeps): Promise<string | null> =>
  runGit(["rev-parse", "HEAD"], cwd)

/**
 * Caches by cwd for the daemon's lifetime, negative results included: a repo's remote identity
 * does not change under us, and a scratch directory must not re-shell on every message it
 * appears on. HEAD deliberately has no place here — see `resolveHeadSha`.
 */
export const createRepoResolver = ({
  runGit,
}: ResolveRepoDeps): ((cwd: string) => Promise<ResolvedRepo | null>) => {
  const byCwd = new Map<string, Promise<ResolvedRepo | null>>()
  return (cwd) => {
    const hit = byCwd.get(cwd)
    if (hit) return hit
    const pending = identityFor(cwd, runGit)
    byCwd.set(cwd, pending)
    return pending
  }
}
