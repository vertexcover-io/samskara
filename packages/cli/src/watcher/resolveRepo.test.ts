import { describe, expect, test } from "vitest"
import { type GitRunner, resolveRepo } from "./resolveRepo.js"

const gitReturning =
  (byArgs: Record<string, string | null>): GitRunner =>
  async (args) =>
    byArgs[args.join(" ")] ?? null

describe("resolveRepo", () => {
  test("parses an ssh github remote", async () => {
    const runGit = gitReturning({
      "config --get remote.origin.url": "git@github.com:refrens/andromeda.git",
    })
    const repo = await resolveRepo("/work/app", { runGit, osUser: "vc" })
    expect(repo).toEqual({
      host: "github",
      owner: "refrens",
      ownerType: "org",
      repoName: "andromeda",
    })
  })

  test("parses an https github remote", async () => {
    const runGit = gitReturning({
      "config --get remote.origin.url": "https://github.com/acme/widget.git",
    })
    const repo = await resolveRepo("/work/app", { runGit, osUser: "vc" })
    expect(repo.owner).toBe("acme")
    expect(repo.repoName).toBe("widget")
  })

  test("falls back to a local identity using the git toplevel", async () => {
    const runGit = gitReturning({
      "config --get remote.origin.url": null,
      "rev-parse --show-toplevel": "/Users/vc/work/myapp\n",
    })
    const repo = await resolveRepo("/Users/vc/work/myapp/src", { runGit, osUser: "vc" })
    expect(repo).toEqual({
      host: "local",
      owner: "vc",
      ownerType: "user",
      repoName: "/Users/vc/work/myapp",
    })
  })

  test("falls back to cwd when not a git repo at all", async () => {
    const runGit: GitRunner = async () => null
    const repo = await resolveRepo("/tmp/loose", { runGit, osUser: "vc" })
    expect(repo.repoName).toBe("/tmp/loose")
    expect(repo.host).toBe("local")
  })
})
