import { describe, expect, test } from "bun:test"
import { dispatchArgs, parseArgs } from "./release.ts"

describe("parseArgs", () => {
  test("takes a bump keyword and defaults the rest", () => {
    expect(parseArgs(["patch"])).toEqual({ bump: "patch", ref: null, watch: false })
    expect(parseArgs(["minor"])).toEqual({ bump: "minor", ref: null, watch: false })
    expect(parseArgs(["major"])).toEqual({ bump: "major", ref: null, watch: false })
  })

  test("takes an explicit version", () => {
    expect(parseArgs(["1.4.0"]).bump).toBe("1.4.0")
    expect(parseArgs(["1.4.0-rc.1"]).bump).toBe("1.4.0-rc.1")
  })

  test("rejects a bump the workflow's own bumper would reject", () => {
    expect(() => parseArgs(["sideways"])).toThrow()
    expect(() => parseArgs(['1.4.0-"rc"'])).toThrow()
  })

  test("reads --ref in both spellings", () => {
    expect(parseArgs(["patch", "--ref", "release/next"]).ref).toBe("release/next")
    expect(parseArgs(["patch", "--ref=release/next"]).ref).toBe("release/next")
  })

  test("reads --watch", () => {
    expect(parseArgs(["patch", "--watch"]).watch).toBe(true)
  })

  test("takes the flags before the bump too", () => {
    expect(parseArgs(["--watch", "patch"])).toEqual({ bump: "patch", ref: null, watch: true })
  })

  test("rejects a --ref with nothing after it", () => {
    expect(() => parseArgs(["patch", "--ref"])).toThrow()
    expect(() => parseArgs(["patch", "--ref="])).toThrow()
  })

  test("rejects an unknown flag rather than silently ignoring it", () => {
    expect(() => parseArgs(["patch", "--dry-run"])).toThrow()
  })

  test("rejects a second bump, which would otherwise be dropped", () => {
    expect(() => parseArgs(["patch", "minor"])).toThrow()
  })

  test("rejects no bump at all", () => {
    expect(() => parseArgs([])).toThrow()
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
