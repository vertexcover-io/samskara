import { lstat, mkdtemp, readdir, readFile, readlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test, vi } from "vitest"
import { createWatchLogger } from "./log.js"
import { currentLogPath, watchLogDir } from "./paths.js"

const originalHome = process.env.SAMSKARA_HOME

const useHome = async (): Promise<string> => {
  const home = await mkdtemp(join(tmpdir(), "samskara-log-"))
  process.env.SAMSKARA_HOME = home
  return home
}

const writtenLogs = async (): Promise<string> => {
  const files = await readdir(watchLogDir())
  const contents = await Promise.all(
    files.map((file) => readFile(join(watchLogDir(), file), "utf8")),
  )
  return contents.join("")
}

afterEach(() => {
  process.env.SAMSKARA_HOME = originalHome
})

describe("watch logger", () => {
  test("maintains a current.log symlink pointing at the active dated file", async () => {
    await useHome()

    const { log, ready } = createWatchLogger({ verbose: false })
    await ready()
    log.info("watcher started")

    const link = currentLogPath()
    await vi.waitFor(async () => expect(await readFile(link, "utf8")).toContain("watcher started"))
    expect((await lstat(link)).isSymbolicLink()).toBe(true)
    expect(await readlink(link)).toMatch(/^watch\.\d{4}-\d{2}-\d{2}\.\d+\.log$/)
    expect(await readFile(link, "utf8")).toContain('"service":"samskara-cli"')
  })

  test("redacts credentials written through the rotating destination", async () => {
    await useHome()

    const { log, ready } = createWatchLogger({ verbose: false })
    await ready()
    log.info({ token: "super-secret-value" }, "sink authenticated")

    await vi.waitFor(async () => expect(await writtenLogs()).toContain("sink authenticated"))
    const joined = await writtenLogs()
    expect(joined).not.toContain("super-secret-value")
    expect(joined).toContain("[Redacted]")
  })
})
