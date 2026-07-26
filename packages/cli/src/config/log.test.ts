import { lstat, mkdtemp, readFile, readdir, readlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import { createWatchLogger } from "./log.js"
import { watchLogDir } from "./paths.js"

const originalHome = process.env.SAMSKARA_HOME

const useHome = async (): Promise<string> => {
  const home = await mkdtemp(join(tmpdir(), "samskara-log-"))
  process.env.SAMSKARA_HOME = home
  return home
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 100))

afterEach(() => {
  process.env.SAMSKARA_HOME = originalHome
})

describe("watch logger", () => {
  test("writes daemon logs into a dated file under the watch log dir", async () => {
    await useHome()

    const { log, ready } = createWatchLogger({ verbose: false })
    await ready()
    log.info({ cycle: 1 }, "watch cycle complete")
    await settle()

    const files = await readdir(watchLogDir())
    expect(files.length).toBeGreaterThan(0)

    const contents = await Promise.all(
      files.map((file) => readFile(join(watchLogDir(), file), "utf8")),
    )
    const joined = contents.join("")
    expect(joined).toContain("watch cycle complete")
    expect(joined).toContain('"service":"samskara-cli"')
  })

  test("maintains a current.log symlink pointing at the active dated file", async () => {
    await useHome()

    const { log, ready } = createWatchLogger({ verbose: false })
    await ready()
    log.info("watcher started")
    await settle()

    const link = join(watchLogDir(), "current.log")
    expect((await lstat(link)).isSymbolicLink()).toBe(true)
    expect(await readlink(link)).toMatch(/^watch\.\d{4}-\d{2}-\d{2}\.\d+\.log$/)
    expect(await readFile(link, "utf8")).toContain("watcher started")
  })

  test("redacts credentials written through the rotating destination", async () => {
    await useHome()

    const { log, ready } = createWatchLogger({ verbose: false })
    await ready()
    log.info({ token: "super-secret-value" }, "sink authenticated")
    await settle()

    const files = await readdir(watchLogDir())
    const joined = (
      await Promise.all(files.map((file) => readFile(join(watchLogDir(), file), "utf8")))
    ).join("")

    expect(joined).toContain("sink authenticated")
    expect(joined).not.toContain("super-secret-value")
    expect(joined).toContain("[Redacted]")
  })
})
