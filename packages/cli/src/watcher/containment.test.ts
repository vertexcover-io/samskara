import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { EXCLUDED_DIRS, EXCLUDED_GLOBS, isCapturable } from "./containment.js"

const ROOT = "/work/app"
const fixtureBase = dirname(fileURLToPath(import.meta.url))

describe("isCapturable", () => {
  const rejected: ReadonlyArray<readonly [string, string]> = [
    ["a sibling directory outside the root", "/work/app-other/src/a.ts"],
    ["a parent of the root", "/work/notes.md"],
    ["a dependency directory", `${ROOT}/node_modules/pkg/index.js`],
    ["a nested dependency directory", `${ROOT}/packages/web/node_modules/pkg/index.js`],
    ["a build output directory", `${ROOT}/dist/bundle.js`],
    ["an environment file", `${ROOT}/.env`],
    ["a suffixed environment file", `${ROOT}/.env.production`],
    ["a lockfile", `${ROOT}/bun.lock`],
    ["an npm lockfile", `${ROOT}/package-lock.json`],
    ["a log file", `${ROOT}/debug.log`],
    ["a macOS directory turd", `${ROOT}/docs/.DS_Store`],
    ["the agent's own config", join(homedir(), ".claude", "settings.json")],
    ["an alternate agent config", join(homedir(), ".agent", "settings.json")],
    ["a scratch file in tmp", "/tmp/scratch.md"],
    ["a scratch file in private tmp", "/private/tmp/scratch.md"],
    ["a home dotfile", join(homedir(), ".zshrc")],
  ]

  const accepted: ReadonlyArray<readonly [string, string]> = [
    ["a source file", `${ROOT}/src/index.ts`],
    ["a file in a sibling monorepo package", `${ROOT}/packages/web/src/App.tsx`],
    ["a repo-root docs file", `${ROOT}/docs/adr-001.md`],
    ["a file whose name merely contains an excluded word", `${ROOT}/src/distribution.ts`],
    ["a directory whose name merely starts with an excluded word", `${ROOT}/building/plan.md`],
  ]

  test.each(rejected)("S6: rejects %s", (_label, path) => {
    expect(isCapturable(path, ROOT)).toBe(false)
  })

  test.each(accepted)("S6: accepts %s", (_label, path) => {
    expect(isCapturable(path, ROOT)).toBe(true)
  })

  test("S6: every excluded directory is rejected", () => {
    for (const dir of EXCLUDED_DIRS) {
      expect(isCapturable(`${ROOT}/${dir}/file.txt`, ROOT)).toBe(false)
    }
  })

  test("S6: every excluded glob is rejected", () => {
    const named = EXCLUDED_GLOBS.map((glob) => glob.replace("*", "file"))
    for (const name of named) {
      expect(isCapturable(`${ROOT}/${name}`, ROOT)).toBe(false)
    }
  })

  test("S7: a gitignored plan or spec is captured, while a build output is not", () => {
    // `.harness/` is gitignored in this very repo, and plans are exactly the high-value
    // output this feature exists to capture -- so exclusion is a list, never `.gitignore`.
    expect(isCapturable(`${ROOT}/.harness/features/x/design.md`, ROOT)).toBe(true)
    expect(isCapturable(`${ROOT}/dist/bundle.js`, ROOT)).toBe(false)
  })
})

describe("isCapturable over real symlinks", () => {
  let base: string
  let root: string
  let outside: string

  afterAll(async () => {
    await rm(base, { recursive: true, force: true })
  })

  beforeAll(async () => {
    // Deliberately NOT the system temp dir: under turbo TMPDIR is /tmp, which the exclusion
    // list rejects outright, so a fixture there would test the /tmp rule rather than symlinks.
    base = await realpath(await mkdtemp(join(fixtureBase, "samskara-containment-")))
    root = join(base, "repo")
    outside = join(base, "outside")
    await mkdir(join(root, "docs"), { recursive: true })
    await mkdir(outside, { recursive: true })
    await writeFile(join(outside, "secret.md"), "outside", "utf8")
    await writeFile(join(root, "docs", "real.md"), "inside", "utf8")
    await symlink(join(outside, "secret.md"), join(root, "escape.md"))
    await symlink(join(root, "docs", "real.md"), join(root, "inside-link.md"))
  })

  test("S8: a symlink pointing outside the root is rejected once resolved", async () => {
    const target = await realpath(join(root, "escape.md"))

    expect(isCapturable(target, root)).toBe(false)
  })

  test("S8: a symlink pointing inside the root is accepted once resolved", async () => {
    const target = await realpath(join(root, "inside-link.md"))

    expect(isCapturable(target, root)).toBe(true)
  })
})
