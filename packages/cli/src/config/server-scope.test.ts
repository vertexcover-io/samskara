import { existsSync } from "node:fs"
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import {
  artifactQueuePath,
  artifactStatePath,
  filterOptionsPath,
  projectsPath,
  statePath,
  tokenPath,
} from "./paths.js"
import { listProjects } from "./projects.js"
import {
  ALL_SCOPED_PATHS,
  resetServerScope,
  scopeMismatch,
  stampOf,
  TRIPWIRE_PATHS,
  warnOnServerChange,
} from "./server-scope.js"
import { writeSettings } from "./settings.js"

const originalHome = process.env.SAMSKARA_HOME
const originalApiUrlEnv = process.env.SAMSKARA_API_URL
const originalDaemonEnv = process.env.SAMSKARA_DAEMON

beforeEach(async () => {
  process.env.SAMSKARA_HOME = await mkdtemp(join(tmpdir(), "samskara-server-scope-"))
})

afterEach(() => {
  process.env.SAMSKARA_HOME = originalHome
  if (originalApiUrlEnv === undefined) delete process.env.SAMSKARA_API_URL
  else process.env.SAMSKARA_API_URL = originalApiUrlEnv
  if (originalDaemonEnv === undefined) delete process.env.SAMSKARA_DAEMON
  else process.env.SAMSKARA_DAEMON = originalDaemonEnv
})

describe("scopeMismatch", () => {
  test("SC2: a projects file stamped for another server is reported as a mismatch, naming both", async () => {
    await writeSettings({ apiUrl: "https://two.example", webUrl: "https://two.example" })
    await writeFile(
      projectsPath(),
      JSON.stringify({ version: 1, apiBase: "https://one.example", projects: {} }),
      "utf8",
    )

    await expect(scopeMismatch(TRIPWIRE_PATHS())).resolves.toEqual([
      { file: projectsPath(), recorded: "https://one.example", current: "https://two.example" },
    ])
  })

  test("SC3: a projects file with no stamp reports nothing, and still parses", async () => {
    await writeSettings({ apiUrl: "https://one.example", webUrl: "https://one.example" })
    await writeFile(projectsPath(), JSON.stringify({ version: 1, projects: {} }), "utf8")

    await expect(scopeMismatch(TRIPWIRE_PATHS())).resolves.toEqual([])
    await expect(listProjects()).resolves.toEqual([])
  })

  test("SC4: an environment override is not a server change", async () => {
    await writeSettings({ apiUrl: "https://one.example", webUrl: "https://one.example" })
    await writeFile(
      projectsPath(),
      JSON.stringify({ version: 1, apiBase: "https://one.example", projects: {} }),
      "utf8",
    )
    process.env.SAMSKARA_API_URL = "https://two.example"

    await expect(scopeMismatch(TRIPWIRE_PATHS())).resolves.toEqual([])
  })

  test("SC5: a projects file that is not there reports nothing, and reads back as the empty shape", async () => {
    await writeSettings({ apiUrl: "https://one.example", webUrl: "https://one.example" })

    await expect(scopeMismatch(TRIPWIRE_PATHS())).resolves.toEqual([])
    await expect(stampOf(projectsPath())).resolves.toBeNull()
    await expect(listProjects()).resolves.toEqual([])
  })
})

describe("warnOnServerChange", () => {
  test("SC8: a matching stamp prints nothing", async () => {
    await writeSettings({ apiUrl: "https://one.example", webUrl: "https://one.example" })
    await writeFile(
      projectsPath(),
      JSON.stringify({ version: 1, apiBase: "https://one.example", projects: {} }),
      "utf8",
    )
    const stderr: string[] = []

    await warnOnServerChange({ write: (text) => stderr.push(text) })

    expect(stderr).toEqual([])
  })

  test("SC9: the daemon does not print the warning even though the stamp disagrees", async () => {
    await writeSettings({ apiUrl: "https://two.example", webUrl: "https://two.example" })
    await writeFile(
      projectsPath(),
      JSON.stringify({ version: 1, apiBase: "https://one.example", projects: {} }),
      "utf8",
    )
    process.env.SAMSKARA_DAEMON = "1"
    const stderr: string[] = []

    await warnOnServerChange({ write: (text) => stderr.push(text) })

    expect(stderr).toEqual([])
  })

  test("a disagreeing stamp prints one line naming both servers and the fix", async () => {
    await writeSettings({ apiUrl: "https://two.example", webUrl: "https://two.example" })
    await writeFile(
      projectsPath(),
      JSON.stringify({ version: 1, apiBase: "https://one.example", projects: {} }),
      "utf8",
    )
    const stderr: string[] = []

    await warnOnServerChange({ write: (text) => stderr.push(text) })

    expect(stderr).toHaveLength(1)
    expect(stderr[0]).toContain("https://one.example")
    expect(stderr[0]).toContain("https://two.example")
    expect(stderr[0]).toContain("samskara init --force")
  })
})

describe("resetServerScope", () => {
  test("SC19/SC20: stops the watcher, backs up every scoped file and the token, deletes the derived files, and disables and strips every project", async () => {
    const home = process.env.SAMSKARA_HOME as string
    await writeSettings({ apiUrl: "https://one.example", webUrl: "https://one.example" })
    await writeFile(
      projectsPath(),
      JSON.stringify({
        version: 1,
        apiBase: "https://one.example",
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
      "utf8",
    )
    await writeFile(
      statePath(),
      JSON.stringify({ apiBase: "https://one.example", checkpoints: {} }),
    )
    await writeFile(
      artifactStatePath(),
      JSON.stringify({ version: 1, apiBase: "https://one.example", artifacts: {} }),
    )
    await writeFile(
      artifactQueuePath(),
      JSON.stringify({ version: 1, apiBase: "https://one.example", entries: [] }),
    )
    await writeFile(filterOptionsPath(), JSON.stringify({ apiBase: "https://one.example" }))
    await writeFile(tokenPath(), "sometoken")

    let stopped = 0
    let backupsExistedAtStop = true
    const report = await resetServerScope({
      stopWatcher: async () => {
        stopped += 1
        backupsExistedAtStop = existsSync(join(home, "backups"))
        return true
      },
    })

    expect(stopped).toBe(1)
    expect(backupsExistedAtStop).toBe(false)
    expect(report.projects).toBe(1)
    expect([...report.cleared].sort()).toEqual(
      [statePath(), artifactStatePath(), artifactQueuePath(), filterOptionsPath()].sort(),
    )

    for (const file of ALL_SCOPED_PATHS()) {
      const backedUp = await readFile(
        join(report.backupDir, file.split("/").pop() as string),
        "utf8",
      )
      expect(backedUp).toContain("https://one.example")
    }
    expect(await readFile(join(report.backupDir, "token"), "utf8")).toBe("sometoken")

    expect(existsSync(statePath())).toBe(false)
    expect(existsSync(artifactStatePath())).toBe(false)
    expect(existsSync(artifactQueuePath())).toBe(false)
    expect(existsSync(filterOptionsPath())).toBe(false)
    expect(existsSync(tokenPath())).toBe(false)

    const projects = JSON.parse(await readFile(projectsPath(), "utf8"))
    expect(projects.projects.acme).toEqual({
      name: "acme",
      path: "/work/acme",
      enabled: false,
      enabledAt: "2026-07-25T10:00:00.000Z",
    })
  })

  // The count is printed to reassure the user their data is safe, immediately before it is deleted.
  // A number describing what was attempted rather than what landed is worse than no number.
  test("SC26: reports the files it actually backed up, not the ones it looked for", async () => {
    await writeSettings({ apiUrl: "https://one.example", webUrl: "https://one.example" })
    await writeFile(projectsPath(), JSON.stringify({ version: 1, projects: {} }), "utf8")
    await writeFile(tokenPath(), "sometoken", "utf8")

    const report = await resetServerScope({ stopWatcher: async () => false })

    expect([...report.backedUp].sort()).toEqual([projectsPath(), tokenPath()].sort())
    expect((await readdir(report.backupDir)).sort()).toEqual(["projects.json", "token"])
  })
})
