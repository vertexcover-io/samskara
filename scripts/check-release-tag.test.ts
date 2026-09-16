import { describe, expect, test } from "bun:test"
import { tagMismatch } from "./check-release-tag.ts"

describe("tagMismatch", () => {
  test("accepts a tag naming the agreed version", () => {
    expect(tagMismatch("v1.4.0", "1.4.0")).toBeNull()
    expect(tagMismatch("v1.4.0-rc.1", "1.4.0-rc.1")).toBeNull()
  })

  test("reports a tag that names a different version", () => {
    expect(tagMismatch("v1.4.0", "1.3.0")).toContain("1.3.0")
  })

  test("reports a tag missing its v, which would ship a differently named tarball", () => {
    expect(tagMismatch("1.4.0", "1.4.0")).not.toBeNull()
  })

  test("reports a tag that is not a release tag at all", () => {
    expect(tagMismatch("master", "1.4.0")).not.toBeNull()
  })
})
