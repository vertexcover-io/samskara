import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import { upsertProject } from "../config/projects.js"
import { captureFilterFor, globAll } from "./index.js"

const originalHome = process.env.SAMSKARA_HOME

afterEach(() => {
  process.env.SAMSKARA_HOME = originalHome
})

test("watch discovery ignores broken symlinks and returns every nested JSONL", async () => {
  const root = await mkdtemp(join(tmpdir(), "samskara-discovery-"))
  const nested = join(root, "project", "subagents")
  await mkdir(nested, { recursive: true })
  await writeFile(join(root, "project", "main.jsonl"), "{}\n", "utf8")
  await writeFile(join(nested, "agent.jsonl"), "{}\n", "utf8")
  await symlink(join(root, "missing"), join(root, "broken-link"))

  const files = await globAll(`${root}/**/*.jsonl`)

  expect([...files].sort()).toEqual(
    [join(root, "project", "main.jsonl"), join(nested, "agent.jsonl")].sort(),
  )
})

describe("watch capture filter", () => {
  test("REQ-026,REQ-027: permits only enabled project slugs", async () => {
    process.env.SAMSKARA_HOME = await mkdtemp(join(tmpdir(), "samskara-filter-"))
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
    const filter = captureFilterFor(undefined)
    if (!filter) throw new Error("expected registry filter")

    await expect(filter({ name: "on", slug: "acme-on" })).resolves.toBe(true)
    await expect(filter({ name: "off", slug: "acme-off" })).resolves.toBe(false)
    await expect(filter({ name: "missing", slug: "acme-missing" })).resolves.toBe(false)
  })

  test("REQ-029,EDGE-013: explicit project override bypasses registry filtering", () => {
    expect(captureFilterFor({ name: "manual", slug: "manual-project" })).toBeUndefined()
  })

  test("REQ-032,EDGE-011: malformed registry defaults to capture none", async () => {
    const home = await mkdtemp(join(tmpdir(), "samskara-filter-malformed-"))
    process.env.SAMSKARA_HOME = home
    await writeFile(join(home, "projects.json"), "broken", "utf8")
    const filter = captureFilterFor(undefined)
    if (!filter) throw new Error("expected registry filter")

    await expect(filter({ name: "widget", slug: "acme-widget" })).resolves.toBe(false)
  })
})
