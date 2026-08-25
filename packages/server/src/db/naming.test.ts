import { spawnSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { expect, test } from "vitest"

// The camelCase-naming check itself now lives as a native Biome plugin
// (packages/server/src/db/naming.grit, registered and scoped to this file in biome.json) rather
// than a hand-rolled script. These tests prove the plugin is wired in and actually bites --
// bun run lint already re-proves it passes on every commit.

const repoDir = fileURLToPath(new URL("../../../..", import.meta.url))
const schemaPath = fileURLToPath(new URL("./schema.ts", import.meta.url))

const runBiome = () =>
  spawnSync("bun", ["x", "biome", "check", "packages/server/src/db/schema.ts"], {
    cwd: repoDir,
    encoding: "utf-8",
  })

test("the live schema.ts passes the camelCase naming plugin cleanly", () => {
  const result = runBiome()
  expect(result.status).toBe(0)
})

test("the plugin fails and names the column when a snake_case identifier is introduced", () => {
  const original = readFileSync(schemaPath, "utf-8")
  const anchor = 'githubId: bigint("githubId", { mode: "number" }).notNull().unique(),'
  const probe = original.replace(anchor, `${anchor}\n  probeCol: text("probe_col"),`)
  if (probe === original) throw new Error("fixture anchor not found in schema.ts")

  writeFileSync(schemaPath, probe)
  try {
    const result = runBiome()
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("probe_col")
    expect(result.stderr).toContain("not camelCase")
  } finally {
    writeFileSync(schemaPath, original)
  }
})
