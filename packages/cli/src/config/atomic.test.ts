import { mkdir, readFile, writeFile } from "node:fs/promises"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "vitest"
import { withFileLock } from "./atomic.js"

describe("file locking", () => {
  test("a live lock owner is never evicted solely because the lock is old", async () => {
    const home = await mkdtemp(join(tmpdir(), "samskara-live-lock-"))
    const target = join(home, "projects.json")
    const lockPath = `${target}.lock`
    await mkdir(lockPath)
    await writeFile(join(lockPath, "owner"), `${process.pid}:live-owner`, "utf8")

    await expect(withFileLock(target, async () => undefined, { timeoutMs: 30 })).rejects.toThrow(
      "timed out acquiring lock",
    )
    expect(await readFile(join(lockPath, "owner"), "utf8")).toBe(`${process.pid}:live-owner`)
  })
})
