import { describe, expect, test } from "bun:test"
import { agreedVersion, nextVersion, readVersion, setVersion } from "./version.ts"

describe("nextVersion", () => {
  test("bumps a segment and zeroes the ones below it", () => {
    expect(nextVersion("1.2.3", "patch")).toBe("1.2.4")
    expect(nextVersion("1.2.3", "minor")).toBe("1.3.0")
    expect(nextVersion("1.2.3", "major")).toBe("2.0.0")
  })

  test("takes an explicit version verbatim", () => {
    expect(nextVersion("1.2.3", "2.0.0")).toBe("2.0.0")
    expect(nextVersion("1.2.3", "2.0.0-rc.1")).toBe("2.0.0-rc.1")
  })

  test("rejects an unknown bump", () => {
    expect(() => nextVersion("1.2.3", "sideways")).toThrow()
  })

  test("rejects a current version it cannot parse", () => {
    expect(() => nextVersion("nightly", "patch")).toThrow()
  })

  test("rejects an explicit version carrying characters that would corrupt JSON", () => {
    expect(() => nextVersion("1.2.3", '1.3.0-"rc"')).toThrow()
    expect(() => nextVersion("1.2.3", "1.3.0-rc\\")).toThrow()
    expect(() => nextVersion("1.2.3", "1.3.0-rc 1")).toThrow()
  })

  test("still takes a well-formed prerelease and build tag", () => {
    expect(nextVersion("1.2.3", "1.3.0-rc.1")).toBe("1.3.0-rc.1")
    expect(nextVersion("1.2.3", "1.3.0+build.5")).toBe("1.3.0+build.5")
    expect(nextVersion("1.2.3", "1.3.0-rc.1+build.5")).toBe("1.3.0-rc.1+build.5")
  })
})

describe("agreedVersion", () => {
  test("returns the version every manifest shares", () => {
    expect(agreedVersion(['{"version": "0.3.0"}', '{"version": "0.3.0"}'])).toBe("0.3.0")
  })

  test("refuses to bump manifests that have already drifted", () => {
    expect(() => agreedVersion(['{"version": "0.3.0"}', '{"version": "0.4.0"}'])).toThrow(/drifted/)
  })

  test("lets a manifest with no version field be filled in from the others", () => {
    expect(agreedVersion(['{"version": "0.3.0"}', '{"name": "@samskara/web"}'])).toBe("0.3.0")
  })

  test("starts at 0.0.0 when no manifest declares a version", () => {
    expect(agreedVersion(['{"name": "@samskara/web"}'])).toBe("0.0.0")
  })
})

describe("setVersion", () => {
  test("rewrites an existing version and leaves the rest of the file alone", () => {
    const source = '{\n  "name": "@samskara/cli",\n  "version": "0.0.0",\n  "private": true\n}\n'
    expect(setVersion(source, "1.4.0")).toBe(
      '{\n  "name": "@samskara/cli",\n  "version": "1.4.0",\n  "private": true\n}\n',
    )
  })

  test("inserts a version after the name when the manifest has none", () => {
    const source = '{\n  "name": "samskara",\n  "private": true\n}\n'
    expect(setVersion(source, "1.4.0")).toBe(
      '{\n  "name": "samskara",\n  "version": "1.4.0",\n  "private": true\n}\n',
    )
  })

  test("round-trips through readVersion", () => {
    const source = '{\n  "name": "samskara",\n  "private": true\n}\n'
    expect(readVersion(setVersion(source, "9.9.9"))).toBe("9.9.9")
  })

  test("refuses a manifest with neither name nor version", () => {
    expect(() => setVersion('{\n  "private": true\n}\n', "1.0.0")).toThrow()
  })
})

describe("readVersion", () => {
  test("returns null when the manifest has no version", () => {
    expect(readVersion('{\n  "name": "samskara"\n}\n')).toBeNull()
  })
})
