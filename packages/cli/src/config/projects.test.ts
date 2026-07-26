import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import { isProjectEnabled, listProjects, setProjectEnabled, upsertProject } from "./projects.js"

const originalHome = process.env.SAMSKARA_HOME

const useTempHome = async (): Promise<string> => {
  const home = await mkdtemp(join(tmpdir(), "samskara-projects-"))
  process.env.SAMSKARA_HOME = home
  return home
}

afterEach(() => {
  process.env.SAMSKARA_HOME = originalHome
})

describe("project registry", () => {
  test("REQ-008: enabling persists the exact camelCase project contract", async () => {
    const home = await useTempHome()

    await upsertProject("acme-widget", {
      name: "widget",
      path: "/work/widget",
      enabled: true,
      enabledAt: "2026-07-25T10:00:00.000Z",
    })

    const raw: unknown = JSON.parse(await readFile(join(home, "projects.json"), "utf8"))
    expect(raw).toEqual({
      version: 1,
      projects: {
        "acme-widget": {
          name: "widget",
          path: "/work/widget",
          enabled: true,
          enabledAt: "2026-07-25T10:00:00.000Z",
        },
      },
    })
  })

  test("REQ-011: disabling an absent project is idempotent", async () => {
    await useTempHome()

    const result = await setProjectEnabled("missing", false)

    expect(result).toBeNull()
    await expect(listProjects()).resolves.toEqual([])
  })

  test("REQ-032: missing or malformed registry reads as empty", async () => {
    const home = await useTempHome()
    await expect(listProjects()).resolves.toEqual([])

    await writeFile(join(home, "projects.json"), "not json", "utf8")
    await expect(listProjects()).resolves.toEqual([])

    await writeFile(join(home, "projects.json"), JSON.stringify({ version: 2 }), "utf8")
    await expect(listProjects()).resolves.toEqual([])
  })

  test("REQ-026,REQ-027,EDGE-011: only enabled slugs report as capture-eligible", async () => {
    const home = await useTempHome()
    await upsertProject("acme-on", {
      name: "on",
      path: "/work/on",
      enabled: true,
      enabledAt: "2026-07-25T10:00:00.000Z",
    })
    await upsertProject("acme-off", {
      name: "off",
      path: "/work/off",
      enabled: false,
      enabledAt: "2026-07-25T10:00:00.000Z",
    })

    await expect(isProjectEnabled("acme-on")).resolves.toBe(true)
    await expect(isProjectEnabled("acme-off")).resolves.toBe(false)
    await expect(isProjectEnabled("acme-missing")).resolves.toBe(false)

    await writeFile(join(home, "projects.json"), "broken", "utf8")
    await expect(isProjectEnabled("acme-on")).resolves.toBe(false)
  })

  test("REQ-009,EDGE-004: concurrent writes preserve unrelated entries", async () => {
    await useTempHome()

    await Promise.all([
      upsertProject("acme-a", {
        name: "a",
        path: "/work/a",
        enabled: true,
        enabledAt: "2026-07-25T10:00:00.000Z",
      }),
      upsertProject("acme-b", {
        name: "b",
        path: "/work/b",
        enabled: true,
        enabledAt: "2026-07-25T10:00:00.000Z",
      }),
    ])

    const slugs = (await listProjects()).map(({ slug }) => slug).sort()
    expect(slugs).toEqual(["acme-a", "acme-b"])
  })
})
