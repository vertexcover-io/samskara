import { describe, expect, test } from "vitest"
import { type GitRunner, resolveProject } from "./resolveProject.js"

const gitReturning =
  (byArgs: Record<string, string | null>): GitRunner =>
  async (args) =>
    byArgs[args.join(" ")] ?? null

describe("resolveProject", () => {
  test("resolves remote identity from the canonical root of a linked worktree", async () => {
    const calls: Array<{ readonly args: ReadonlyArray<string>; readonly cwd: string }> = []
    const runGit: GitRunner = async (args, cwd) => {
      calls.push({ args, cwd })
      if (args.join(" ") === "rev-parse --path-format=absolute --git-common-dir") {
        return "/work/app/.git"
      }
      if (args.join(" ") === "config --get remote.origin.url") {
        return "git@github.com:refrens/andromeda.git"
      }
      return null
    }
    const project = await resolveProject("/work/app/.worktrees/feature", { runGit })
    expect(project).toEqual({ name: "andromeda", slug: "refrens-andromeda" })
    expect(calls).toEqual([
      {
        args: ["rev-parse", "--path-format=absolute", "--git-common-dir"],
        cwd: "/work/app/.worktrees/feature",
      },
      { args: ["config", "--get", "remote.origin.url"], cwd: "/work/app" },
    ])
  })

  test("parses an https github remote", async () => {
    const runGit = gitReturning({
      "config --get remote.origin.url": "https://github.com/acme/widget.git",
    })
    const project = await resolveProject("/work/app", { runGit })
    expect(project).toEqual({ name: "widget", slug: "acme-widget" })
  })

  test("REQ-007: falls back to cwd basename + separator-replaced slug when not a git repo", async () => {
    const runGit: GitRunner = async () => null
    const project = await resolveProject("/Users/vc/work/myapp", { runGit })
    expect(project).toEqual({ name: "myapp", slug: "-Users-vc-work-myapp" })
  })

  test("falls back when there is no remote", async () => {
    const runGit = gitReturning({ "config --get remote.origin.url": null })
    const project = await resolveProject("/tmp/loose", { runGit })
    expect(project).toEqual({ name: "loose", slug: "-tmp-loose" })
  })

  test("replaces windows path separators in the slug", async () => {
    const runGit: GitRunner = async () => null
    const project = await resolveProject("C:\\Users\\vc\\app", { runGit })
    expect(project).toEqual({ name: "app", slug: "C:-Users-vc-app" })
  })
})
