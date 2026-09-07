import type { RepoIdentity } from "@samskara/core"
import { runGitOrNull } from "../git.js"
import { basename, gitRootOf, resolveRemote } from "./resolveProject.js"

export type ResolvedRepo = RepoIdentity & { readonly root: string }

/**
 * A repo with no remote still needs a stable identity, so its root stands in for the remote.
 * `host: "local"` keeps it from colliding with a remote-backed repo of the same basename.
 */
const LOCAL_HOST = "local"

/** Rejects, via `resolveRemote`, when an ssh alias could not be resolved — see the resolver below. */
const identityFor = async (cwd: string): Promise<ResolvedRepo | null> => {
  const root = await gitRootOf(cwd)
  if (root === null) return null
  const remote = await runGitOrNull(["config", "--get", "remote.origin.url"], root)
  const parsed = remote ? await resolveRemote(remote) : null
  // `ownerType` is deliberately absent: a remote URL cannot tell a user repo from an org one, and
  // it is not part of the repo's identity, so leaving it unknown never splits one repo in two.
  if (parsed) return { ...parsed, root }
  return { host: LOCAL_HOST, owner: root, repoName: basename(root), root }
}

/**
 * Deliberately uncached and never folded into `createRepoResolver`: HEAD moves on every commit,
 * checkout and rebase, so it is only correct at the moment a session starts. The watcher polls
 * after the fact, so a later read returns a sha the session never ran on.
 */
export const resolveHeadSha = (cwd: string): Promise<string | null> =>
  runGitOrNull(["rev-parse", "HEAD"], cwd)

/**
 * Caches by cwd for the daemon's lifetime, negative results included: a repo's remote identity
 * does not change under us, and a scratch directory must not re-shell on every message it
 * appears on. HEAD deliberately has no place here — see `resolveHeadSha`.
 *
 * An unresolved ssh alias is the exception, and it rejects rather than answering with the alias
 * host: that host is most of a repo's identity, so recording it would split the repo from its org
 * exactly as before this fix, permanently and server-side. The rejection is not cached either, so
 * the next message retries instead of being pinned until the daemon restarts.
 */
export const createRepoResolver = (): ((cwd: string) => Promise<ResolvedRepo | null>) => {
  const byCwd = new Map<string, Promise<ResolvedRepo | null>>()
  return (cwd) => {
    const hit = byCwd.get(cwd)
    if (hit) return hit
    const pending = identityFor(cwd)
    byCwd.set(cwd, pending)
    // The rejection belongs to the caller; this only drops the entry so the next call retries.
    pending.catch(() => byCwd.delete(cwd))
    return pending
  }
}
