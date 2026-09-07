import { beforeEach, describe, expect, test, vi } from "vitest"
import { runGitOrNull } from "../git.js"
import { canonicalSshHost } from "../ssh.js"
import { createRepoResolver, resolveHeadSha } from "./resolveRepo.js"

vi.mock("../git.js", () => ({ runGitOrNull: vi.fn(async () => null) }))
vi.mock("../ssh.js", () => ({ canonicalSshHost: vi.fn() }))

const git = vi.mocked(runGitOrNull)
const ssh = vi.mocked(canonicalSshHost)

beforeEach(() => {
  ssh.mockImplementation(async (host: string) => host)
})

const gitReturning = (byArgs: Record<string, string | null>) => {
  git.mockImplementation(async (args) => byArgs[args.join(" ")] ?? null)
}

describe("resolveRepoIdentity", () => {
  test("an alias ssh could not resolve rejects rather than answering under the alias host, which would split the repo from its org server-side and for good", async () => {
    gitReturning({
      "rev-parse --path-format=absolute --git-common-dir": "/work/andromeda/.git",
      "config --get remote.origin.url": "git@github-refrens:refrens/andromeda.git",
    })
    ssh.mockRejectedValue(new Error("spawn ssh ENOENT"))

    await expect(createRepoResolver()("/work/andromeda")).rejects.toThrow("ENOENT")
  })

  test("that rejection is not cached, so one lost lookup does not pin the checkout until the daemon restarts", async () => {
    gitReturning({
      "rev-parse --path-format=absolute --git-common-dir": "/work/andromeda/.git",
      "config --get remote.origin.url": "git@github-refrens:refrens/andromeda.git",
    })
    ssh.mockRejectedValueOnce(new Error("spawn ssh ENOENT"))
    const resolve = createRepoResolver()

    await expect(resolve("/work/andromeda")).rejects.toThrow()

    ssh.mockImplementation(async () => "github.com")
    expect(await resolve("/work/andromeda")).toMatchObject({ host: "github.com" })
  })

  test("a resolved identity is still cached, so a settled alias is not re-shelled on every message", async () => {
    gitReturning({
      "rev-parse --path-format=absolute --git-common-dir": "/work/andromeda/.git",
      "config --get remote.origin.url": "git@github-refrens:refrens/andromeda.git",
    })
    const resolve = createRepoResolver()

    await resolve("/work/andromeda")
    await resolve("/work/andromeda")

    expect(ssh).toHaveBeenCalledTimes(1)
  })

  test("an ssh config alias resolves to the host it really points at, so the repo is not split from every other clone and its web links are not dead", async () => {
    ssh.mockImplementation(async (host) => (host === "github-refrens" ? "github.com" : host))
    gitReturning({
      "rev-parse --path-format=absolute --git-common-dir": "/work/andromeda/.git",
      "config --get remote.origin.url": "git@github-refrens:refrens/andromeda.git",
    })

    expect(await createRepoResolver()("/work/andromeda")).toEqual({
      host: "github.com",
      owner: "refrens",
      repoName: "andromeda",
      root: "/work/andromeda",
    })
  })

  test("S1: an ssh remote of refrens/serana resolves to host github.com, owner refrens, repoName serana, without the .git suffix", async () => {
    gitReturning({
      "rev-parse --path-format=absolute --git-common-dir": "/work/serana/.git",
      "config --get remote.origin.url": "git@github.com:refrens/serana.git",
    })

    expect(await createRepoResolver()("/work/serana")).toEqual({
      host: "github.com",
      owner: "refrens",
      repoName: "serana",
      root: "/work/serana",
    })
  })

  test("S2: a remoteless repo is identified by its root under host 'local', so it never collides with a remote-backed repo of the same basename", async () => {
    gitReturning({
      "rev-parse --path-format=absolute --git-common-dir": "/home/dev/serana/.git",
      "config --get remote.origin.url": null,
    })
    const local = await createRepoResolver()("/home/dev/serana")

    gitReturning({
      "rev-parse --path-format=absolute --git-common-dir": "/work/serana/.git",
      "config --get remote.origin.url": "git@github.com:refrens/serana.git",
    })
    const remoted = await createRepoResolver()("/work/serana")

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
    git.mockImplementation(async (args) => {
      if (args[0] === "rev-parse") return "/work/serana/.git"
      if (args[0] === "config") return "git@github.com:refrens/serana.git"
      return null
    })

    const resolved = await createRepoResolver()("/work/serana/.worktrees/feature")

    expect(resolved).toEqual({
      host: "github.com",
      owner: "refrens",
      repoName: "serana",
      root: "/work/serana",
    })
    // The remote is read from the main checkout, so a worktree cannot answer differently.
    expect(git.mock.calls[1]?.[1]).toBe("/work/serana")
  })

  test("S4: a cwd where every git call fails resolves to null rather than throwing", async () => {
    await expect(createRepoResolver()("/private/tmp/scratch")).resolves.toBeNull()
  })

  test("S5: resolving one cwd three times shells out only on the first call, and a cwd that resolved to null is not retried either", async () => {
    git.mockImplementation(async (args, cwd) => {
      if (cwd.startsWith("/private/tmp")) return null
      if (args[0] === "rev-parse") return "/work/serana/.git"
      return "git@github.com:refrens/serana.git"
    })
    const resolve = createRepoResolver()

    const resolved = await Promise.all([
      resolve("/work/serana"),
      resolve("/work/serana"),
      resolve("/work/serana"),
    ])
    expect(new Set(resolved.map((r) => r?.repoName))).toEqual(new Set(["serana"]))
    const afterHits = git.mock.calls.length
    expect(afterHits).toBe(2)

    const misses = await Promise.all([
      resolve("/private/tmp/scratch"),
      resolve("/private/tmp/scratch"),
      resolve("/private/tmp/scratch"),
    ])
    expect(misses).toEqual([null, null, null])
    expect(git.mock.calls.length - afterHits).toBe(1)
  })
})

describe("resolveHeadSha", () => {
  test("reads HEAD in the cwd it was given, uncached, so a session's origin sha is the one it started at", async () => {
    git.mockResolvedValue("37f31013b7ac0a2e6f4c9d1e5a8b2c7d0e3f4a5b")

    expect(await resolveHeadSha("/work/serana")).toBe("37f31013b7ac0a2e6f4c9d1e5a8b2c7d0e3f4a5b")
    expect(git.mock.calls).toEqual([[["rev-parse", "HEAD"], "/work/serana"]])
  })

  test("EC6: a cwd outside any git repo yields a null starting sha rather than an error", async () => {
    await expect(resolveHeadSha("/private/tmp/scratch")).resolves.toBeNull()
  })
})
