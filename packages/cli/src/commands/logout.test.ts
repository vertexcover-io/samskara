import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import { storeToken } from "../config/credentials.js"
import { upsertProject } from "../config/projects.js"
import { logoutCommand } from "./logout.js"

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
    let stopped = false
    const output: string[] = []

    const code = await logoutCommand({
      stopWatcher: async () => {
        stopped = true
        return true
      },
      stdout: { write: (text) => output.push(text) },
    })

    expect(code).toBe(0)
    expect(stopped).toBe(true)
    await expect(readFile(join(home, "token"), "utf8")).rejects.toMatchObject({ code: "ENOENT" })
    expect(await readFile(join(home, "projects.json"), "utf8")).toBe(projectsBefore)
    expect(output.join("")).toContain("logged out; watcher stopped")
  })

  test("EDGE-010: succeeds when no watcher or token exists", async () => {
    const home = await mkdtemp(join(tmpdir(), "samskara-logout-empty-"))
    process.env.SAMSKARA_HOME = home
    await writeFile(join(home, "projects.json"), '{"version":1,"projects":{}}', "utf8")

    const code = await logoutCommand({ stopWatcher: async () => false })

    expect(code).toBe(0)
    expect(await readFile(join(home, "projects.json"), "utf8")).toBe('{"version":1,"projects":{}}')
  })
})
