import { describe, expect, test } from "bun:test"
import { tagMismatch } from "./check-release-tag.ts"

describe("tagMismatch", () => {
  test("accepts a tag naming the agreed version", () => {
    expect(tagMismatch("v1.4.0", "1.4.0")).toBeNull()
    expect(tagMismatch("v1.4.0-rc.1", "1.4.0-rc.1")).toBeNull()
  })

  test.each([
    ["names a different version", "v1.4.0", "1.3.0"],
    ["is missing its v, which would ship a differently named tarball", "1.4.0", "1.4.0"],
    ["is not a release tag at all", "master", "1.4.0"],
  ])("reports a tag that %s", (_case, tag, version) => {
    expect(tagMismatch(tag, version)).not.toBeNull()
  })

  test("names the agreed version in the report", () => {
    expect(tagMismatch("v1.4.0", "1.3.0")).toContain("1.3.0")
  })
})
