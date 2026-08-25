import { describe, expect, test } from "bun:test"
import { bundledCoreManifest, releaseManifest } from "./pack-cli.ts"

const cliPackage = {
  name: "@samskara/cli",
  version: "0.0.0",
  private: true,
  type: "module",
  bin: { samskara: "./dist/index.js" },
  scripts: { build: "tsc -p tsconfig.build.json" },
  dependencies: {
    "@samskara/core": "workspace:*",
    commander: "13.1.0",
    "pino-roll": "^4.0.0",
    zod: "^4.4.3",
  },
  devDependencies: { typescript: "5.7.3" },
}

const corePackage = {
  name: "@samskara/core",
  version: "0.0.0",
  private: true,
  type: "module",
  main: "./dist/index.js",
  types: "./dist/index.d.ts",
  exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } },
  scripts: { build: "tsc -p tsconfig.build.json" },
  dependencies: { pino: "^9", zod: "^4.0.0" },
  devDependencies: { vitest: "3.0.5" },
}

describe("releaseManifest", () => {
  const manifest = releaseManifest(cliPackage, corePackage, "1.4.0")

  test("pins the workspace dependency to the release version", () => {
    expect(manifest.dependencies["@samskara/core"]).toBe("1.4.0")
    expect(JSON.stringify(manifest)).not.toContain("workspace:")
  })

  test("declares core as bundled so npm never asks the registry for it", () => {
    expect(manifest.bundleDependencies).toEqual(["@samskara/core"])
  })

  test("hoists core's own dependencies so bundled core can resolve them by walking up", () => {
    expect(manifest.dependencies.pino).toBe("^9")
  })

  test("lets the cli's own range win when both declare the same dependency", () => {
    expect(manifest.dependencies.zod).toBe("^4.4.3")
  })

  test("keeps the cli's other dependencies as they are", () => {
    expect(manifest.dependencies.commander).toBe("13.1.0")
    expect(manifest.dependencies["pino-roll"]).toBe("^4.0.0")
  })

  test("keeps the bin entry and the release version", () => {
    expect(manifest.bin).toEqual({ samskara: "./dist/index.js" })
    expect(manifest.version).toBe("1.4.0")
  })

  test("stays private so it can never be published by accident", () => {
    expect(manifest.private).toBe(true)
  })

  test("drops build-time fields the installed package has no use for", () => {
    expect(manifest.devDependencies).toBeUndefined()
    expect(manifest.scripts).toBeUndefined()
  })

  test("refuses a cli manifest that does not depend on core", () => {
    expect(() =>
      releaseManifest({ ...cliPackage, dependencies: {} }, corePackage, "1.4.0"),
    ).toThrow()
  })
})

describe("bundledCoreManifest", () => {
  const manifest = bundledCoreManifest(corePackage, "1.4.0")

  test("carries the release version so the pinned dependency resolves", () => {
    expect(manifest.version).toBe("1.4.0")
  })

  test("keeps the entry points node needs to resolve the package", () => {
    expect(manifest.main).toBe("./dist/index.js")
    expect(manifest.exports).toEqual(corePackage.exports)
  })

  /** npm leaves an empty placeholder directory for every dependency of a bundled package, which
   * breaks the real copy installed alongside it. Declaring none avoids that entirely. */
  test("declares no dependencies of its own", () => {
    expect(manifest.dependencies).toBeUndefined()
  })

  test("drops build-time fields", () => {
    expect(manifest.devDependencies).toBeUndefined()
    expect(manifest.scripts).toBeUndefined()
  })
})
