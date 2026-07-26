import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test, vi } from "vitest"
import { storeToken } from "../config/credentials.js"
import { upsertProject } from "../config/projects.js"
import { logoutCommand } from "./logout.js"

let watcherRunning = false
vi.mock("../config/daemon.js", () => ({
  stopWatcherDaemon: vi.fn(async () => {
    watcherRunning = false
    return true
  }),
}))

const originalHome = process.env.SAMSKARA_HOME

afterEach(() => {
  process.env.SAMSKARA_HOME = originalHome
})

describe("logout command", () => {
  test("REQ-015,REQ-016: stops the watcher and deletes only credentials", async () => {
    const home = await mkdtemp(join(tmpdir(), "samskara-logout-"))
    process.env.SAMSKARA_HOME = home
    await storeToken("secret-token")
    await upsertProject("acme-widget", {
      name: "widget",
      path: "/work/widget",
      enabled: true,
      enabledAt: "2026-07-25T10:00:00.000Z",
    })
    const projectsBefore = await readFile(join(home, "projects.json"), "utf8")
    const output: string[] = []
    watcherRunning = true

    const code = await logoutCommand({ stdout: { write: (text) => output.push(text) } })

    expect(code).toBe(0)
    expect(watcherRunning).toBe(false)
    await expect(readFile(join(home, "token"), "utf8")).rejects.toMatchObject({ code: "ENOENT" })
    expect(await readFile(join(home, "projects.json"), "utf8")).toBe(projectsBefore)
  })

  test("EDGE-010: succeeds when no watcher or token exists", async () => {
    const home = await mkdtemp(join(tmpdir(), "samskara-logout-empty-"))
    process.env.SAMSKARA_HOME = home
    await writeFile(join(home, "projects.json"), '{"version":1,"projects":{}}', "utf8")

    const code = await logoutCommand()

    expect(code).toBe(0)
    expect(await readFile(join(home, "projects.json"), "utf8")).toBe('{"version":1,"projects":{}}')
  })
})
