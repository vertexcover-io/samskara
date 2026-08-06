import { resolve } from "node:path"
import { describe, expect, test, vi } from "vitest"
import { runGitOrNull } from "../git.js"
import { resolveProject } from "./resolveProject.js"

vi.mock("../git.js", () => ({ runGitOrNull: vi.fn(async () => null) }))

const git = vi.mocked(runGitOrNull)

const gitReturning = (byArgs: Record<string, string | null>) => {
  git.mockImplementation(async (args) => byArgs[args.join(" ")] ?? null)
}

describe("resolveProject", () => {
  test("resolves remote identity from the canonical root of a linked worktree", async () => {
    gitReturning({
      "rev-parse --path-format=absolute --git-common-dir": "/work/app/.git",
      "config --get remote.origin.url": "git@github.com:refrens/andromeda.git",
    })

    const project = await resolveProject("/work/app/.worktrees/feature")

    // A linked worktree resolves to its parent repo's root, because the root comes from
    // `--git-common-dir` rather than the working directory.
    expect(project).toEqual({ name: "andromeda", slug: "refrens-andromeda", root: "/work/app" })
    expect(git.mock.calls).toEqual([
      [["rev-parse", "--path-format=absolute", "--git-common-dir"], "/work/app/.worktrees/feature"],
      [["config", "--get", "remote.origin.url"], "/work/app"],
    ])
  })

  test("parses an https github remote", async () => {
    gitReturning({
      "config --get remote.origin.url": "https://github.com/acme/widget.git",
    })

    expect(await resolveProject("/work/app")).toEqual({
      name: "widget",
      slug: "acme-widget",
      root: "/work/app",
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

  test("a relative start dir is resolved against the cwd before it becomes an identity", async () => {
    const project = await resolveProject("some/nested/dir")

    expect(project.root).toBe(resolve("some/nested/dir"))
    expect(project.name).toBe("dir")
    // Whatever the platform's separator is, none of it survives into the slug.
    expect(project.slug).not.toMatch(/[/\\]/)
  })
})
