import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { projectsPath } from "./paths.js"
import { listProjects } from "./projects.js"
import { scopeMismatch, stampOf, TRIPWIRE_PATHS } from "./server-scope.js"
import { writeSettings } from "./settings.js"

const originalHome = process.env.SAMSKARA_HOME
const originalApiUrlEnv = process.env.SAMSKARA_API_URL

beforeEach(async () => {
  process.env.SAMSKARA_HOME = await mkdtemp(join(tmpdir(), "samskara-server-scope-"))
})

afterEach(() => {
  process.env.SAMSKARA_HOME = originalHome
  if (originalApiUrlEnv === undefined) delete process.env.SAMSKARA_API_URL
  else process.env.SAMSKARA_API_URL = originalApiUrlEnv
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
