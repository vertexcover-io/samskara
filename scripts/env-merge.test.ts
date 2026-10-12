import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const SCRIPT = join(import.meta.dir, "..", "deploy", "files", "env-merge.sh")

const merge = (file: string, overrides: string): string => {
  const dir = mkdtempSync(join(tmpdir(), "env-merge-"))
  const path = join(dir, ".env")
  writeFileSync(path, file)
  const run = Bun.spawnSync(["bash", SCRIPT, path], { stdin: Buffer.from(overrides) })
  if (run.exitCode !== 0) throw new Error(run.stderr.toString())
  return readFileSync(path, "utf8")
}

describe("env-merge.sh", () => {
  test("replaces an existing key on its own line and appends a missing one", () => {
    const out = merge("# comment\nA=1\n\nB=2\n", "B=22\nC=3\n")
    expect(out).toBe("# comment\nA=1\n\nB=22\nC=3\n")
  })

  test("tolerates the shapes applyEnv accepts", () => {
    const out = merge("  A = 1\nB=2\n", "A=one\n")
    expect(out).toBe("A=one\nB=2\n")
  })

  test("leaves a file without overrides untouched", () => {
    expect(merge("A=1\n# end\n", "")).toBe("A=1\n# end\n")
  })

  test("appends new keys in input order and keeps a value containing '='", () => {
    const out = merge("A=1\n", "Z=z\nURL=postgres://u:p@h/db?a=b\n")
    expect(out).toBe("A=1\nZ=z\nURL=postgres://u:p@h/db?a=b\n")
  })

  test("does not treat a comment mentioning a key as an assignment", () => {
    const out = merge("# A=old\nA=1\n", "A=2\n")
    expect(out).toBe("# A=old\nA=2\n")
  })
})
