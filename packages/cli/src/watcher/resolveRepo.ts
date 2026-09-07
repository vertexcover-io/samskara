import type { RepoIdentity } from "@samskara/core"
import { runGitOrNull } from "../git.js"
import { basename, gitRootOf, resolveRemote } from "./resolveProject.js"

export type ResolvedRepo = RepoIdentity & { readonly root: string }

/**
 * A repo with no remote still needs a stable identity, so its root stands in for the remote.
 * `host: "local"` keeps it from colliding with a remote-backed repo of the same basename.
 */
const LOCAL_HOST = "local"

type Attempt = { readonly repo: ResolvedRepo | null; readonly certain: boolean }

const identityFor = async (cwd: string): Promise<Attempt> => {
  const root = await gitRootOf(cwd)
  if (root === null) return { repo: null, certain: true }
  const remote = await runGitOrNull(["config", "--get", "remote.origin.url"], root)
  const resolved = remote ? await resolveRemote(remote) : null
  // `ownerType` is deliberately absent: a remote URL cannot tell a user repo from an org one, and
  // it is not part of the repo's identity, so leaving it unknown never splits one repo in two.
  if (resolved) return { repo: { ...resolved.remote, root }, certain: resolved.certain }
  return { repo: { host: LOCAL_HOST, owner: root, repoName: basename(root), root }, certain: true }
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
 * An identity whose ssh alias went unresolved is the exception. It is returned but not kept, so a
 * lookup that lost once to a timeout or a half-installed ssh does not pin the repo under its alias
 * host — and split from its org — for every later message from that checkout.
 */
export const createRepoResolver = (): ((cwd: string) => Promise<ResolvedRepo | null>) => {
  const byCwd = new Map<string, Promise<ResolvedRepo | null>>()
  return (cwd) => {
    const hit = byCwd.get(cwd)
    if (hit) return hit
    const attempt = identityFor(cwd)
    const pending = attempt.then((a) => a.repo)
    byCwd.set(cwd, pending)
    // The rejection, if there is one, belongs to `pending` and its caller; this branch only
    // decides whether to keep the entry.
    attempt.then(
      (a) => {
        if (!a.certain) byCwd.delete(cwd)
      },
      () => byCwd.delete(cwd),
    )
    return pending
  }
}
