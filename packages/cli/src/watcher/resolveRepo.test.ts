import { describe, expect, test } from "vitest"
import type { GitRunner } from "./resolveProject.js"
import { createRepoResolver, resolveHeadSha } from "./resolveRepo.js"

const gitReturning =
  (byArgs: Record<string, string | null>): GitRunner =>
  async (args) =>
    byArgs[args.join(" ")] ?? null

describe("resolveRepoIdentity", () => {
  test("S1: an ssh remote of refrens/serana resolves to host github.com, owner refrens, repoName serana, without the .git suffix", async () => {
    const resolve = createRepoResolver({
      runGit: gitReturning({
        "rev-parse --path-format=absolute --git-common-dir": "/work/serana/.git",
        "config --get remote.origin.url": "git@github.com:refrens/serana.git",
      }),
    })

    // No `ownerType`: a remote URL cannot tell a user repo from an org one, so it is left
    // unknown rather than guessed.
    expect(await resolve("/work/serana")).toEqual({
      host: "github.com",
      owner: "refrens",
      repoName: "serana",
      root: "/work/serana",
    })
  })

  test("S2: a remoteless repo is identified by its root under host 'local', so it never collides with a remote-backed repo of the same basename", async () => {
    const resolveRemoteless = createRepoResolver({
      runGit: gitReturning({
        "rev-parse --path-format=absolute --git-common-dir": "/home/dev/serana/.git",
        "config --get remote.origin.url": null,
      }),
    })
    const resolveRemoted = createRepoResolver({
      runGit: gitReturning({
        "rev-parse --path-format=absolute --git-common-dir": "/work/serana/.git",
        "config --get remote.origin.url": "git@github.com:refrens/serana.git",
      }),
    })

    const local = await resolveRemoteless("/home/dev/serana")
    const remoted = await resolveRemoted("/work/serana")

    expect(local).not.toBeNull()
    expect(local?.host).toBe("local")
    expect(local?.repoName).toBe("serana")
    expect(remoted?.repoName).toBe("serana")
    expect({ host: local?.host, owner: local?.owner }).not.toEqual({
      host: remoted?.host,
      owner: remoted?.owner,
    })
  })

  test("S3: a linked worktree resolves to its main checkout's identity and root, not to a repo of its own", async () => {
    const calls: Array<{ readonly args: ReadonlyArray<string>; readonly cwd: string }> = []
    const runGit: GitRunner = async (args, cwd) => {
      calls.push({ args, cwd })
      if (args[0] === "rev-parse") return "/work/serana/.git"
      if (args[0] === "config") return "git@github.com:refrens/serana.git"
      return null
    }

    const resolved = await createRepoResolver({ runGit })("/work/serana/.worktrees/feature")

    expect(resolved?.root).toBe("/work/serana")
    expect(resolved).toEqual({
      host: "github.com",
      owner: "refrens",
      repoName: "serana",
      root: "/work/serana",
    })
    // The remote is read from the main checkout, so a worktree cannot answer differently.
    expect(calls[1]?.cwd).toBe("/work/serana")
  })

  test("S4: a cwd where every git call fails resolves to null rather than throwing", async () => {
    const resolve = createRepoResolver({ runGit: async () => null })

    await expect(resolve("/private/tmp/scratch")).resolves.toBeNull()
  })

  test("S5: resolving one cwd three times shells out only on the first call, and a cwd that resolved to null is not retried either", async () => {
    let calls = 0
    const runGit: GitRunner = async (args, cwd) => {
      calls += 1
      if (cwd.startsWith("/private/tmp")) return null
      if (args[0] === "rev-parse") return "/work/serana/.git"
      return "git@github.com:refrens/serana.git"
    }
    const resolve = createRepoResolver({ runGit })

    const resolved = await Promise.all([
      resolve("/work/serana"),
      resolve("/work/serana"),
      resolve("/work/serana"),
    ])
    expect(new Set(resolved.map((r) => r?.repoName))).toEqual(new Set(["serana"]))
    const afterHits = calls
    expect(afterHits).toBe(2)

    const misses = await Promise.all([
      resolve("/private/tmp/scratch"),
      resolve("/private/tmp/scratch"),
      resolve("/private/tmp/scratch"),
    ])
    expect(misses).toEqual([null, null, null])
    // One `rev-parse` for the negative result, then nothing: a scratch directory must not
    // re-shell on every message it appears on.
    expect(calls - afterHits).toBe(1)
  })
})

describe("resolveHeadSha", () => {
  test("reads HEAD in the cwd it was given, uncached, so a session's origin sha is the one it started at", async () => {
    const seen: string[] = []
    const runGit: GitRunner = async (args, cwd) => {
      seen.push(`${args.join(" ")}@${cwd}`)
      return "37f31013b7ac0a2e6f4c9d1e5a8b2c7d0e3f4a5b"
    }

    expect(await resolveHeadSha("/work/serana", { runGit })).toBe(
      "37f31013b7ac0a2e6f4c9d1e5a8b2c7d0e3f4a5b",
    )
    expect(seen).toEqual(["rev-parse HEAD@/work/serana"])
  })

  test("EC6: a cwd outside any git repo yields a null starting sha rather than an error", async () => {
    await expect(
      resolveHeadSha("/private/tmp/scratch", { runGit: async () => null }),
    ).resolves.toBeNull()
  })
})
