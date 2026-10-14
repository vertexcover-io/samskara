import { describe, expect, test } from "bun:test"
import { agreedVersion, nextVersion, readVersion, setVersion } from "./version.ts"

describe("nextVersion", () => {
  test("bumps a segment and zeroes the ones below it", () => {
    expect(nextVersion("1.2.3", "patch")).toBe("1.2.4")
    expect(nextVersion("1.2.3", "minor")).toBe("1.3.0")
    expect(nextVersion("1.2.3", "major")).toBe("2.0.0")
  })

  test.each(["2.0.0", "2.0.0-rc.1", "1.3.0+build.5", "1.3.0-rc.1+build.5"])(
    "takes the well-formed explicit version %s verbatim",
    (explicit) => {
      expect(nextVersion("1.2.3", explicit)).toBe(explicit)
    },
  )

  test.each([
    ["an unknown bump", "1.2.3", "sideways"],
    ["a current version it cannot parse", "nightly", "patch"],
    ["an explicit version with a quote, which would corrupt JSON", "1.2.3", '1.3.0-"rc"'],
    ["an explicit version with a backslash, which would corrupt JSON", "1.2.3", "1.3.0-rc\\"],
    ["an explicit version with a space", "1.2.3", "1.3.0-rc 1"],
  ])("rejects %s", (_case, current, bump) => {
    expect(() => nextVersion(current, bump)).toThrow()
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
