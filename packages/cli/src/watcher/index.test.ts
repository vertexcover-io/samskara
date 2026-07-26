import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, test } from "vitest"
import { globAll } from "./index.js"

const originalHome = process.env.SAMSKARA_HOME

afterEach(() => {
  process.env.SAMSKARA_HOME = originalHome
})

test("watch discovery ignores broken symlinks and returns every nested JSONL", async () => {
  const root = await mkdtemp(join(tmpdir(), "samskara-discovery-"))
  const nested = join(root, "project", "subagents")
  await mkdir(nested, { recursive: true })
  await writeFile(join(root, "project", "main.jsonl"), "{}\n", "utf8")
  await writeFile(join(nested, "agent.jsonl"), "{}\n", "utf8")
  await symlink(join(root, "missing"), join(root, "broken-link"))

  const files = await globAll(`${root}/**/*.jsonl`)

  expect([...files].sort()).toEqual(
    [join(root, "project", "main.jsonl"), join(nested, "agent.jsonl")].sort(),
  )
})
