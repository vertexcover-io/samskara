import { execFileSync, spawnSync } from "node:child_process"
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "vitest"
import { isEntrypoint } from "./index.js"
import { cliVersion } from "./version.js"

const entry = fileURLToPath(new URL("./index.ts", import.meta.url))

test("samskara --version prints the version and exits 0", () => {
  const out = execFileSync("bun", [entry, "--version"], { encoding: "utf8" })
  expect(out.trim()).toBe(cliVersion)
})

test("capture lifecycle commands are exposed while ensure remains hidden", () => {
  const out = execFileSync("bun", [entry, "--help"], { encoding: "utf8" })
  const listed = out
    .slice(out.indexOf("Commands:"))
    .split("\n")
    .map((line) => line.trim().split(/[\s[]/)[0])
    .filter(Boolean)

  expect(listed).toEqual(
    expect.arrayContaining([
      "init",
      "login",
      "logout",
      "enable",
      "disable",
      "status",
      "watch",
      "restart",
      "upgrade",
      "logs",
      "install-hooks",
      "uninstall-hooks",
    ]),
  )
  expect(listed).not.toContain("ensure")
})

test("a symlinked bin counts as the entrypoint, as a global install invokes it", () => {
  const dir = mkdtempSync(join(tmpdir(), "samskara-bin-"))
  const link = join(dir, "samskara")
  symlinkSync(entry, link)
  expect(isEntrypoint(link, import.meta.url.replace("index.test.ts", "index.ts"))).toBe(true)
})

test("an unrelated argv[1] is not the entrypoint", () => {
  expect(isEntrypoint(entry.replace("index.ts", "login.ts"), import.meta.url)).toBe(false)
  expect(isEntrypoint(undefined, import.meta.url)).toBe(false)
  expect(isEntrypoint("/nope/does-not-exist", import.meta.url)).toBe(false)
})

test("SC7: a command run against a different server warns on stderr, naming both, and still does its job", () => {
  const home = mkdtempSync(join(tmpdir(), "samskara-scope-e2e-"))
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({ version: 1, apiUrl: "https://two.example", webUrl: "https://two.example" }),
  )
  writeFileSync(
    join(home, "projects.json"),
    JSON.stringify({ version: 1, apiBase: "https://one.example", projects: {} }),
  )

  const result = spawnSync("bun", [entry, "status"], {
    encoding: "utf8",
    env: { ...process.env, SAMSKARA_HOME: home },
  })

  expect(result.status).toBe(0)
  const stderrLines = result.stderr.trim().split("\n")
  expect(stderrLines).toHaveLength(1)
  expect(stderrLines[0]).toContain("https://one.example")
  expect(stderrLines[0]).toContain("https://two.example")
  expect(stderrLines[0]).toContain("samskara init --force")
  // The command still did its own job: `status` ran to completion and printed its report.
  expect(result.stdout).toContain("Server")
})

// The preAction hook warns for every command, and a writing command refuses on its own. Both used
// to fire, so one mismatch printed two near-identical lines differing only in their last two words.
test.each(["enable", "disable"])(
  "SC27: `%s` reports a mismatch once, not once per guard",
  (command) => {
    const home = mkdtempSync(join(tmpdir(), "samskara-scope-dup-"))
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ version: 1, apiUrl: "https://two.example", webUrl: "https://two.example" }),
    )
    writeFileSync(
      join(home, "projects.json"),
      JSON.stringify({ version: 1, apiBase: "https://one.example", projects: {} }),
    )

    const result = spawnSync("bun", [entry, command, home], {
      encoding: "utf8",
      env: { ...process.env, SAMSKARA_HOME: home },
    })

    expect(result.status).toBe(1)
    const stderrLines = result.stderr.trim().split("\n").filter(Boolean)
    expect(stderrLines).toHaveLength(1)
    expect(stderrLines[0]).toContain("samskara init --force")
  },
)

/** Stamped copies of every derived file, plus a real token, so a reset has something to move. */
const seedScopedFiles = (home: string, apiBase: string): void => {
  writeFileSync(
    join(home, "projects.json"),
    JSON.stringify({
      version: 1,
      apiBase,
      projects: {
        acme: {
          name: "acme",
          path: "/work/acme",
          enabled: true,
          enabledAt: "2026-07-25T10:00:00.000Z",
          projectId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
        },
      },
    }),
  )
  writeFileSync(join(home, "state.json"), JSON.stringify({ apiBase, checkpoints: {} }))
  writeFileSync(
    join(home, "artifacts.json"),
    JSON.stringify({ version: 1, apiBase, artifacts: {} }),
  )
  writeFileSync(
    join(home, "artifact-queue.json"),
    JSON.stringify({ version: 1, apiBase, entries: [] }),
  )
  writeFileSync(join(home, "filter-options.json"), JSON.stringify({ apiBase }))
  writeFileSync(join(home, "token"), "sometoken")
}

test("SC18: a real `init --force` run backs up before it deletes", () => {
  const home = mkdtempSync(join(tmpdir(), "samskara-reset-e2e-"))
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({ version: 1, apiUrl: "https://one.example", webUrl: "https://one.example" }),
  )
  seedScopedFiles(home, "https://one.example")

  const result = spawnSync(
    "bun",
    [entry, "init", "--force", "--server", "https://two.example", "--web", "https://two.example"],
    { encoding: "utf8", env: { ...process.env, SAMSKARA_HOME: home } },
  )

  expect(result.status).toBe(0)
  const backupsDir = join(home, "backups")
  const [backupName] = readdirSync(backupsDir)
  expect(backupName).toBeDefined()
  const backupDir = join(backupsDir, backupName as string)
  expect(readdirSync(backupDir).sort()).toEqual(
    [
      "artifact-queue.json",
      "artifacts.json",
      "filter-options.json",
      "projects.json",
      "state.json",
      "token",
    ].sort(),
  )
  expect(result.stdout).toContain(backupDir)
  expect(result.stdout).toContain("samskara login")
  expect(result.stdout).toContain("samskara enable")
})

test("SC22: a server change is survivable end to end", () => {
  const home = mkdtempSync(join(tmpdir(), "samskara-journey-e2e-"))
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({ version: 1, apiUrl: "https://one.example", webUrl: "https://one.example" }),
  )
  seedScopedFiles(home, "https://one.example")
  // Now point config.json at server B, so every scoped file disagrees with it.
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({ version: 1, apiUrl: "https://two.example", webUrl: "https://two.example" }),
  )
  const env = { ...process.env, SAMSKARA_HOME: home }

  const runStatus = spawnSync("bun", [entry, "status"], { encoding: "utf8", env })
  expect(runStatus.status).toBe(0)
  expect(runStatus.stderr).toContain("https://one.example")
  expect(runStatus.stderr).toContain("https://two.example")

  const runInit = spawnSync("bun", [entry, "init"], { encoding: "utf8", env })
  expect(runInit.status).not.toBe(0)
  expect(runInit.stdout + runInit.stderr).toContain("samskara init --force")
  expect(JSON.parse(readFileSync(join(home, "config.json"), "utf8")).apiUrl).toBe(
    "https://two.example",
  )

  const runForce = spawnSync(
    "bun",
    [entry, "init", "--force", "--server", "https://two.example", "--web", "https://two.example"],
    { encoding: "utf8", env },
  )
  expect(runForce.status).toBe(0)

  expect(readdirSync(join(home, "backups"))).toHaveLength(1)
  expect(existsSync(join(home, "state.json"))).toBe(false)
  expect(existsSync(join(home, "artifacts.json"))).toBe(false)
  expect(existsSync(join(home, "artifact-queue.json"))).toBe(false)
  expect(existsSync(join(home, "filter-options.json"))).toBe(false)
  expect(existsSync(join(home, "token"))).toBe(false)

  const projects = JSON.parse(readFileSync(join(home, "projects.json"), "utf8"))
  expect(projects.apiBase).toBe("https://two.example")
  expect(projects.projects.acme.enabled).toBe(false)
  expect(projects.projects.acme.projectId).toBeUndefined()
})
