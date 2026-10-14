import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const ROOT = join(import.meta.dir, "..")

// biome.json's noExplicitAny and noTsIgnore miss @ts-expect-error (noTsIgnore's own fix suggests
// it) and anything a biome-ignore comment switches those two rules off for.
const BANNED = [
  /@ts-ignore/,
  /@ts-expect-error/,
  /biome-ignore[^\n]*noExplicitAny/,
  /biome-ignore[^\n]*noTsIgnore/,
]

const sources = (): ReadonlyArray<string> =>
  Bun.spawnSync(["git", "ls-files", "*.ts", "*.tsx"], { cwd: ROOT })
    .stdout.toString()
    .split("\n")
    .filter((path) => path !== "" && path !== "scripts/no-suppressions.test.ts")

test("no tracked TypeScript file uses @ts-expect-error or biome-ignores noExplicitAny", () => {
  const offenders = sources().filter((path) =>
    BANNED.some((pattern) => pattern.test(readFileSync(join(ROOT, path), "utf8"))),
  )
  expect(offenders).toEqual([])
})
