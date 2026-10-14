import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { bundledCoreManifest, releaseManifest, tarballName } from "./pack-cli.ts"

const cliPackage = {
  name: "@vertexcover/samskara",
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

  /** Trusted publishing and provenance reject a package whose repository is not the repo the
   * workflow runs in. */
  test("publishes a public, MIT-licensed package under the cli's scoped name from the release repo, with core bundled", () => {
    expect(manifest).toMatchObject({
      name: "@vertexcover/samskara",
      version: "1.4.0",
      license: "MIT",
      bin: { samskara: "./dist/index.js" },
      bundleDependencies: ["@samskara/core"],
      publishConfig: { access: "public" },
      repository: { type: "git", url: "git+https://github.com/vertexcover-io/samskara.git" },
    })
    expect(manifest.private).toBeUndefined()
    expect(manifest.publishConfig).toEqual({ access: "public" })
    expect(manifest.repository).toEqual({
      type: "git",
      url: "git+https://github.com/vertexcover-io/samskara.git",
    })
  })

  test("pins core to the release version, hoists core's dependencies, and lets the cli's own ranges win", () => {
    expect(manifest.dependencies).toEqual({
      "@samskara/core": "1.4.0",
      commander: "13.1.0",
      "pino-roll": "^4.0.0",
      zod: "^4.4.3",
      pino: "^9",
    })
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

test("the workspace cli manifest is the package the release publishes, and stays private so only the packed tarball can be published", () => {
  const workspace: unknown = JSON.parse(
    readFileSync(new URL("../packages/cli/package.json", import.meta.url), "utf8"),
  )
  expect(workspace).toMatchObject({ name: "@vertexcover/samskara", private: true })
})

describe("tarballName", () => {
  /** npm pack names the file after the package, but the release asset keeps its original name:
   * the Homebrew formula and the README's versioned download link fetch it by that name. */
  test("keeps the release asset name independent of the package name", () => {
    expect(tarballName("1.4.0")).toBe("samskara-cli-1.4.0.tgz")
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
