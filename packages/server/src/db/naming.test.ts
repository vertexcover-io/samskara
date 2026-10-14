import { spawnSync } from "node:child_process"
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, expect, test } from "vitest"
import { z } from "zod"

const repoDir = fileURLToPath(new URL("../../../..", import.meta.url))
const schemaRelPath = "packages/server/src/db/schema.ts"

const BiomeConfigSchema = z
  .object({ plugins: z.array(z.object({ path: z.string() }).passthrough()) })
  .passthrough()

let workDir: string | undefined

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true })
  workDir = undefined
})

const copyIntoWorkDir = (dir: string, relPath: string, contents?: string): void => {
  const target = join(dir, relPath)
  mkdirSync(dirname(target), { recursive: true })
  if (contents === undefined) cpSync(join(repoDir, relPath), target)
  else writeFileSync(target, contents)
}

test("the plugin fails and names the column when a snake_case identifier is introduced", () => {
  const original = readFileSync(join(repoDir, schemaRelPath), "utf-8")
  const anchor = 'githubId: bigint("githubId", { mode: "number" }).notNull().unique(),'
  const probe = original.replace(anchor, `${anchor}\n  probeCol: text("probe_col"),`)
  if (probe === original) throw new Error("fixture anchor not found in schema.ts")

  const config = BiomeConfigSchema.parse(
    JSON.parse(readFileSync(join(repoDir, "biome.json"), "utf-8")),
  )
  const dir = mkdtempSync(join(tmpdir(), "samskara-naming-"))
  workDir = dir
  writeFileSync(join(dir, "biome.json"), JSON.stringify({ ...config, vcs: { enabled: false } }))
  for (const plugin of config.plugins) copyIntoWorkDir(dir, plugin.path)
  copyIntoWorkDir(dir, schemaRelPath, probe)

  const result = spawnSync(join(repoDir, "node_modules/.bin/biome"), ["lint", schemaRelPath], {
    cwd: dir,
    encoding: "utf-8",
  })
  expect(result.status).not.toBe(0)
  expect(result.stderr).toContain("probe_col")
  expect(result.stderr).toContain("not camelCase")
})
