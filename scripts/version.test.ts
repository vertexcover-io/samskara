import { describe, expect, test } from "bun:test"
import { nextVersion, readVersion, setVersion } from "./version.ts"

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
