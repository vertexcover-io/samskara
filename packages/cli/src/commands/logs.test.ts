import { appendFile, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test, vi } from "vitest"
import { currentLogPath } from "../config/paths.js"
import { logsCommand } from "./logs.js"

const originalHome = process.env.SAMSKARA_HOME

const useHome = async (): Promise<string> => {
  const home = await mkdtemp(join(tmpdir(), "samskara-logs-"))
  process.env.SAMSKARA_HOME = home
  await mkdir(join(home, "logs"), { recursive: true })
  return home
}

const output = () => {
  const stdout: string[] = []
  const stderr: string[] = []
  return {
    stdout,
    stderr,
    writers: {
      stdout: { write: (text: string) => stdout.push(text) },
      stderr: { write: (text: string) => stderr.push(text) },
    },
  }
}

afterEach(() => {
  process.env.SAMSKARA_HOME = originalHome
})

describe("logs command", () => {
  test("pretty-prints the active log resolved through the current.log symlink", async () => {
    const home = await useHome()
    await writeFile(
      join(home, "logs", "watch.2026-07-26.1.log"),
      `${JSON.stringify({ level: 30, time: Date.now(), service: "samskara-cli", msg: "watch cycle complete" })}\n`,
      "utf8",
    )
    await symlink("watch.2026-07-26.1.log", join(home, "logs", "current.log"))
    const streams = output()

    const code = await logsCommand({ follow: false, colorize: false, ...streams.writers })

    expect(code).toBe(0)
    expect(streams.stdout.join("")).toContain("watch cycle complete")
    expect(streams.stdout.join("")).not.toContain('"level":30')
  })

  test("follow prints a line appended while the initial dump is being written, and every later line, each once", async () => {
    const home = await useHome()
    const target = join(home, "logs", "watch.2026-07-26.1.log")
    const entry = (msg: string): string =>
      `${JSON.stringify({ level: 30, time: Date.now(), service: "samskara-cli", msg })}\n`
    await writeFile(target, entry("first line"), "utf8")
    await symlink("watch.2026-07-26.1.log", join(home, "logs", "current.log"))
    const streams = output()
    const appended: Promise<void>[] = []
    const stdout = {
      write: (text: string) => {
        streams.stdout.push(text)
        if (appended.length === 0 && text.includes("first line")) {
          appended.push(
            new Promise((resolve) => {
              setImmediate(() => resolve(appendFile(target, entry("racing line"), "utf8")))
            }),
          )
        }
      },
    }

    void logsCommand({ follow: true, colorize: false, stdout, stderr: streams.writers.stderr })
    await vi.waitFor(() => expect(appended).toHaveLength(1))
    await appended[0]
    await appendFile(target, entry("later line"), "utf8")
    await vi.waitFor(() => expect(streams.stdout.join("")).toContain("later line"))

    const printed = streams.stdout.join("")
    expect(printed.match(/racing line/g)).toHaveLength(1)
    expect(printed.match(/later line/g)).toHaveLength(1)
  })

  test("reports a helpful message when no log file exists yet", async () => {
    await useHome()
    const streams = output()

    const code = await logsCommand({ follow: false, ...streams.writers })

    expect(code).toBe(1)
    expect(streams.stderr.join("")).toContain(currentLogPath())
  })
})
