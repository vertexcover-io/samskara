import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, resolve } from "node:path"
import { expect, test } from "vitest"

const BANNED = [/:\s*any\b/, /\bas\s+any\b/, /@ts-ignore/, /@ts-expect-error/]

const webPackage = process.cwd()

const sourceRoots = [
  join(webPackage, "src"),
  resolve(webPackage, "../server/src"),
  resolve(webPackage, "../../e2e"),
]

const thisFile = join(webPackage, "src", "no-suppressions.test.ts")

const walk = (dir: string): ReadonlyArray<string> =>
  readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) return walk(path)
    return /\.tsx?$/.test(path) && path !== thisFile ? [path] : []
  })

test("S4: no source file under web, server, or e2e contains ': any', 'as any', or a ts-suppression comment", () => {
  const offenders = sourceRoots
    .flatMap(walk)
    .filter((path) => BANNED.some((pattern) => pattern.test(readFileSync(path, "utf8"))))

  expect(offenders).toEqual([])
})
