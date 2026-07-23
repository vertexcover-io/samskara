import type { RepoIdentity } from "@samskara/core"

export type GitRunner = (args: ReadonlyArray<string>, cwd: string) => Promise<string | null>

export type ResolveRepoDeps = {
  readonly runGit: GitRunner
  readonly osUser: string
}

const parseRemote = (url: string): { readonly owner: string; readonly repoName: string } | null => {
  const cleaned = url.trim().replace(/\.git$/, "")
  const ssh = cleaned.match(/^git@[^:]+:([^/]+)\/(.+)$/)
  if (ssh?.[1] && ssh[2]) return { owner: ssh[1], repoName: ssh[2] }
  const https = cleaned.match(/^https?:\/\/[^/]+\/([^/]+)\/(.+)$/)
  if (https?.[1] && https[2]) return { owner: https[1], repoName: https[2] }
  return null
}

const localIdentity = (osUser: string, path: string): RepoIdentity => ({
  host: "local",
  owner: osUser,
  ownerType: "user",
  repoName: path,
})

export const resolveRepo = async (
  cwd: string,
  { runGit, osUser }: ResolveRepoDeps,
): Promise<RepoIdentity> => {
  const remote = await runGit(["config", "--get", "remote.origin.url"], cwd)
  const parsed = remote ? parseRemote(remote) : null
  if (parsed) {
    return {
      host: "github",
      owner: parsed.owner,
      ownerType: "org",
      repoName: parsed.repoName,
    }
  }

  const toplevel = await runGit(["rev-parse", "--show-toplevel"], cwd)
  return localIdentity(osUser, toplevel?.trim() ?? cwd)
}
