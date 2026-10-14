import { describe, expect, test } from "bun:test"
import { dispatchArgs, parseArgs } from "./release.ts"

describe("parseArgs", () => {
  test.each([
    [["patch"], { bump: "patch", ref: null, watch: false }],
    [["minor"], { bump: "minor", ref: null, watch: false }],
    [["major"], { bump: "major", ref: null, watch: false }],
    [["1.4.0"], { bump: "1.4.0", ref: null, watch: false }],
    [["1.4.0-rc.1"], { bump: "1.4.0-rc.1", ref: null, watch: false }],
    [["patch", "--ref", "release/next"], { bump: "patch", ref: "release/next", watch: false }],
    [["patch", "--ref=release/next"], { bump: "patch", ref: "release/next", watch: false }],
    [["patch", "--watch"], { bump: "patch", ref: null, watch: true }],
    [["--watch", "patch"], { bump: "patch", ref: null, watch: true }],
  ])("reads %j", (args, expected) => {
    expect(parseArgs(args)).toEqual(expected)
  })

  test.each([
    ["a bump the workflow's own bumper would reject", ["sideways"]],
    ["an explicit version that would corrupt JSON", ['1.4.0-"rc"']],
    ["a --ref with nothing after it", ["patch", "--ref"]],
    ["an empty --ref=", ["patch", "--ref="]],
    ["an unknown flag rather than silently ignoring it", ["patch", "--dry-run"]],
    ["a second bump, which would otherwise be dropped", ["patch", "minor"]],
    ["no bump at all", []],
  ])("rejects %s", (_case, args) => {
    expect(() => parseArgs(args)).toThrow()
  })
})

describe("dispatchArgs", () => {
  test("dispatches the release workflow against the resolved ref", () => {
    expect(dispatchArgs("patch", "master")).toEqual([
      "workflow",
      "run",
      "release.yml",
      "--ref",
      "master",
      "-f",
      "bump=patch",
    ])
  })
})
