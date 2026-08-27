import { stat } from "node:fs/promises"
import { resolve } from "node:path"
import { beforeEach, describe, expect, test, vi } from "vitest"
import { runGitOrNull } from "../git.js"
import { resolveProject } from "./resolveProject.js"

vi.mock("../git.js", () => ({ runGitOrNull: vi.fn(async () => null) }))
// The identities under test are pure path arithmetic, so the directories stay imaginary.
vi.mock("node:fs/promises", () => ({
  realpath: vi.fn(async (path: string) => path),
  stat: vi.fn(async () => ({ isDirectory: () => true })),
}))

const git = vi.mocked(runGitOrNull)

const gitReturning = (byArgs: Record<string, string | null>) => {
  git.mockImplementation(async (args) => byArgs[args.join(" ")] ?? null)
}

beforeEach(() => {
  vi.mocked(stat).mockResolvedValue({ isDirectory: () => true } as unknown as Awaited<
    ReturnType<typeof stat>
  >)
})

describe("resolveProject", () => {
  test("resolves remote identity from the canonical root of a linked worktree", async () => {
    gitReturning({
      "rev-parse --path-format=absolute --git-common-dir": "/work/app/.git",
      "config --get remote.origin.url": "git@github.com:refrens/andromeda.git",
    })

    const project = await resolveProject("/work/app/.worktrees/feature")

    // A linked worktree resolves to its parent repo's root, because the root comes from
    // `--git-common-dir` rather than the working directory.
    expect(project).toEqual({
      name: "andromeda",
      slug: "refrens-andromeda",
      root: "/work/app",
      remote: { host: "github.com", owner: "refrens", repoName: "andromeda" },
    })
    expect(git.mock.calls).toEqual([
      [["rev-parse", "--path-format=absolute", "--git-common-dir"], "/work/app/.worktrees/feature"],
      [["config", "--get", "remote.origin.url"], "/work/app"],
    ])
  })

  test("SC42: resolveProject returns the remote for a repo with an origin, and none without", async () => {
    gitReturning({
      "config --get remote.origin.url": "https://github.com/acme/widget.git",
    })

    expect(await resolveProject("/work/app")).toEqual({
      name: "widget",
      slug: "acme-widget",
      root: "/work/app",
      remote: { host: "github.com", owner: "acme", repoName: "widget" },
    })

    gitReturning({ "config --get remote.origin.url": null })

    expect(await resolveProject("/tmp/loose")).toEqual({
      name: "loose",
      slug: "-tmp-loose",
      root: "/tmp/loose",
    })
  })

  test("REQ-007: falls back to cwd basename + separator-replaced slug when not a git repo", async () => {
    expect(await resolveProject("/Users/vc/work/myapp")).toEqual({
      name: "myapp",
      slug: "-Users-vc-work-myapp",
      root: "/Users/vc/work/myapp",
    })
  })

  test("falls back when there is no remote", async () => {
    gitReturning({ "config --get remote.origin.url": null })

    expect(await resolveProject("/tmp/loose")).toEqual({
      name: "loose",
      slug: "-tmp-loose",
      root: "/tmp/loose",
    })
  })

  test("a directory that is gone has no identity, rather than one invented from its path", async () => {
    // A cwd read from an old transcript can name a removed worktree. Git cannot run there, and the
    // path-derived fallback would mint a slug matching no project -- which reads downstream as
    // "capture is off" rather than "this cannot be identified".
    vi.mocked(stat).mockRejectedValue(new Error("ENOENT: no such file or directory"))

    expect(await resolveProject("/work/app/.worktrees/gone")).toBeNull()
    expect(git).not.toHaveBeenCalled()
  })

  test("a path that exists but is not a directory has no identity either", async () => {
    vi.mocked(stat).mockResolvedValue({ isDirectory: () => false } as unknown as Awaited<
      ReturnType<typeof stat>
    >)

    expect(await resolveProject("/work/app/notes.txt")).toBeNull()
  })

  test("a relative start dir is resolved against the cwd before it becomes an identity", async () => {
    const project = await resolveProject("some/nested/dir")

    expect(project?.root).toBe(resolve("some/nested/dir"))
    expect(project?.name).toBe("dir")
    // Whatever the platform's separator is, none of it survives into the slug.
    expect(project?.slug).not.toMatch(/[/\\]/)
  })
})
