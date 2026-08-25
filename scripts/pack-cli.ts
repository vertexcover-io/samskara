#!/usr/bin/env bun
import { execFileSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const CORE = "@samskara/core"

type Dependencies = Record<string, string>

type CliManifest = {
  name: string
  version: string
  bin: Record<string, string>
  dependencies: Dependencies
  [key: string]: unknown
}

type CoreManifest = {
  name: string
  main: string
  types: string
  exports: unknown
  dependencies: Dependencies
  [key: string]: unknown
}

type ReleaseManifest = {
  name: string
  version: string
  private: true
  type: "module"
  description: string
  license: string
  bin: Record<string, string>
  engines: { node: string }
  dependencies: Dependencies
  bundleDependencies: string[]
}

type BundledCoreManifest = {
  name: string
  version: string
  private: true
  type: "module"
  main: string
  types: string
  exports: unknown
}

/** `workspace:*` means nothing outside this repo, and core is never published, so the tarball pins
 * core to the release version and ships it inside itself as a bundled dependency.
 *
 * Core's own dependencies are hoisted here rather than declared on core: npm leaves an empty
 * placeholder directory for every dependency of a bundled package, which breaks the real copy
 * installed alongside it. Hoisted, they install normally and bundled core resolves them by
 * walking up out of its own directory. The cli's range wins when both declare the same package. */
export const releaseManifest = (
  cli: CliManifest,
  core: CoreManifest,
  version: string,
): ReleaseManifest => {
  if (!(CORE in cli.dependencies)) throw new Error(`the cli manifest does not depend on ${CORE}`)
  const dependencies = { ...core.dependencies, ...cli.dependencies, [CORE]: version }
  return {
    name: cli.name,
    version,
    private: true,
    type: "module",
    description: "Capture and search AI coding-agent session logs",
    license: "MIT",
    bin: cli.bin,
    engines: { node: ">=22" },
    dependencies,
    bundleDependencies: [CORE],
  }
}

export const bundledCoreManifest = (core: CoreManifest, version: string): BundledCoreManifest => ({
  name: core.name,
  version,
  private: true,
  type: "module",
  main: core.main,
  types: core.types,
  exports: core.exports,
})

const repoRoot = fileURLToPath(new URL("..", import.meta.url))
const outDir = join(repoRoot, "dist")
const stageDir = join(outDir, "cli-release")

const readManifest = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T

const writeManifest = (path: string, manifest: unknown): void => {
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`)
}

const requireBuild = (dist: string, name: string): void => {
  if (existsSync(join(dist, "index.js"))) return
  throw new Error(
    `${name} is not built (${join(dist, "index.js")} is missing): run \`bun run build\``,
  )
}

const notSourceMap = (path: string): boolean => !path.endsWith(".map")

const main = (): void => {
  const cliDir = join(repoRoot, "packages/cli")
  const coreDir = join(repoRoot, "packages/core")
  requireBuild(join(cliDir, "dist"), "@samskara/cli")
  requireBuild(join(coreDir, "dist"), CORE)

  const cli = readManifest<CliManifest>(join(cliDir, "package.json"))
  const core = readManifest<CoreManifest>(join(coreDir, "package.json"))
  const version = cli.version

  rmSync(stageDir, { recursive: true, force: true })
  const bundledDir = join(stageDir, "node_modules", CORE)
  mkdirSync(bundledDir, { recursive: true })

  cpSync(join(cliDir, "dist"), join(stageDir, "dist"), { recursive: true, filter: notSourceMap })
  cpSync(join(coreDir, "dist"), join(bundledDir, "dist"), { recursive: true, filter: notSourceMap })
  cpSync(join(repoRoot, "README.md"), join(stageDir, "README.md"))
  cpSync(join(repoRoot, "LICENSE"), join(stageDir, "LICENSE"))
  writeManifest(join(stageDir, "package.json"), releaseManifest(cli, core, version))
  writeManifest(join(bundledDir, "package.json"), bundledCoreManifest(core, version))

  const packed = execFileSync("npm", ["pack", "--pack-destination", outDir], {
    cwd: stageDir,
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .filter((line) => line.endsWith(".tgz"))
    .at(-1)
  if (packed === undefined) throw new Error("npm pack did not report a tarball")

  rmSync(stageDir, { recursive: true, force: true })
  console.log(join(outDir, packed))
}

if (import.meta.main) {
  try {
    main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
