import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import { login } from "./login.js"

const originalHome = process.env.SAMSKARA_HOME

afterEach(() => {
  process.env.SAMSKARA_HOME = originalHome
})

describe("login command", () => {
  test("REQ-017,REQ-033,EDGE-016: exchanges a code and stores the token under SAMSKARA_HOME at 0600", async () => {
    const home = await mkdtemp(join(tmpdir(), "samskara-login-"))
    process.env.SAMSKARA_HOME = home
    await writeFile(join(home, "projects.json"), '{"version":1,"projects":{}}', "utf8")
    await writeFile(join(home, "watch.log"), "watcher ready\n", "utf8")
    await writeFile(join(home, "token"), "old-token", { mode: 0o644 })
    const output: string[] = []

    const code = await login({
      code: "PAIR-CODE",
      fetch: async () => new Response(JSON.stringify({ token: "cli-token" }), { status: 200 }),
      stdout: { write: (text) => output.push(text) },
      stderr: { write: (text) => output.push(text) },
    })

    const path = join(home, "token")
    expect(code).toBe(0)
    expect(await readFile(path, "utf8")).toBe("cli-token")
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(await readFile(join(home, "projects.json"), "utf8")).not.toContain("cli-token")
    expect(await readFile(join(home, "watch.log"), "utf8")).not.toContain("cli-token")
    expect(output.join("")).toContain(`Logged in. Token stored at ${path}`)
  })

  test("REQ-017: reports pairing failures without writing credentials", async () => {
    const home = await mkdtemp(join(tmpdir(), "samskara-login-fail-"))
    process.env.SAMSKARA_HOME = home
    const errors: string[] = []

    const code = await login({
      code: "BAD",
      fetch: async () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }),
      stderr: { write: (text) => errors.push(text) },
    })

    expect(code).toBe(1)
    await expect(readFile(join(home, "token"), "utf8")).rejects.toMatchObject({ code: "ENOENT" })
    expect(errors.join("")).toContain("pairing failed (401)")
  })
})
