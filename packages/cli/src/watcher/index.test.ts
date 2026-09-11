import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ProjectIdentity } from "@samskara/core"
import { afterEach, expect, test, vi } from "vitest"
import { upsertProject } from "../config/projects.js"
import { writeSettings } from "../config/settings.js"
import { drainWorkers, globAll, watch, withStoredProjectId } from "./index.js"
import { silentLogger, spyLogger } from "./test-logger.js"

const originalHome = process.env.SAMSKARA_HOME

afterEach(() => {
  process.env.SAMSKARA_HOME = originalHome
})

test("SC43: the watcher stamps the stored projectId onto the identity", async () => {
  const home = await mkdtemp(join(tmpdir(), "samskara-watcher-index-"))
  process.env.SAMSKARA_HOME = home
  const projectId = "00000000-0000-4000-8000-000000000009"
  await upsertProject("acme-widget", {
    name: "widget",
    path: "/work/widget",
    enabled: true,
    enabledAt: "2026-07-25T10:00:00.000Z",
    projectId,
  })

  const withId: ProjectIdentity = { name: "widget", slug: "acme-widget" }
  const withoutId: ProjectIdentity = { name: "other", slug: "other" }

  expect(await withStoredProjectId(withId)).toEqual({ ...withId, projectId })
  expect(await withStoredProjectId(withoutId)).toEqual(withoutId)
})

test("SC10: the watcher refuses to start when local state disagrees with the configured server", async () => {
  const home = await mkdtemp(join(tmpdir(), "samskara-watcher-scope-"))
  process.env.SAMSKARA_HOME = home
  await writeFile(join(home, "token"), "test-token", "utf8")
  await writeSettings({ apiUrl: "https://two.example", webUrl: "https://two.example" })
  const stateContent = JSON.stringify({ apiBase: "https://one.example", checkpoints: {} })
  await writeFile(join(home, "state.json"), stateContent, "utf8")

  await expect(watch({ log: silentLogger() })).rejects.toThrow(
    "Local state was captured against https://one.example, but this CLI is configured for " +
      "https://two.example. Run `samskara init --force` before capturing again.",
  )

  // No cycle ran: the file was never re-read and rewritten with the new server's stamp.
  expect(await readFile(join(home, "state.json"), "utf8")).toBe(stateContent)
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

/**
 * Shutdown drains in-flight artifact uploads by racing the worker pool against a grace
 * deadline (`watcher/index.ts` -- SIGINT/SIGTERM handler). These scenarios exercise that race
 * directly, without a real signal, a real process, or a real worker pool: `drainWorkers` is
 * the extracted decision of "did the workers finish, or did the grace period run out first".
 */

const neverSleeps = () => new Promise<void>(() => {}) // never resolves on its own

test("shutdown drain: workers finishing before the grace deadline drains without waiting it out", async () => {
  const onDrained = vi.fn()
  let sleepCalls = 0
  const sleep = (_ms: number) => {
    sleepCalls += 1
    return neverSleeps() // grace timer never fires -- workers must be what completes the race
  }

  await drainWorkers(Promise.resolve(), 5_000, sleep, onDrained)

  expect(onDrained).toHaveBeenCalledTimes(1)
  expect(sleepCalls).toBe(1) // the grace timer was still armed, just lost the race
})

test("shutdown drain: a worker pool that never settles is bounded by the grace deadline", async () => {
  const onDrained = vi.fn()
  const hangingWorkers = new Promise<void>(() => {}) // simulates an upload that never resolves
  const sleep = (ms: number) => {
    expect(ms).toBe(5_000)
    return Promise.resolve() // grace timer fires immediately in this scenario
  }

  await drainWorkers(hangingWorkers, 5_000, sleep, onDrained)

  expect(onDrained).toHaveBeenCalledTimes(1)
})

test("shutdown drain: onDrained fires exactly once even if both sides could settle", async () => {
  const onDrained = vi.fn()
  const sleep = (_ms: number) => Promise.resolve()

  await drainWorkers(Promise.resolve(), 1, sleep, onDrained)

  expect(onDrained).toHaveBeenCalledTimes(1)
})

test("an unreadable transcript directory is logged, not silently reported as zero sessions", async () => {
  const root = await mkdtemp(join(tmpdir(), "samskara-discovery-fail-"))
  const spy = spyLogger()

  const files = await globAll(`${root}/missing/**/*.jsonl`, spy.log)

  expect(files).toEqual([])
  const [entry] = spy.error
  expect(entry).toBeDefined()
  expect(entry?.message).toContain("transcript directory unreadable")
  expect(entry?.details.dir).toBe(join(root, "missing"))
  expect((entry?.details.err as { stack?: string } | undefined)?.stack).toContain("ENOENT")
})

test("discovery without a logger still works, so the signature stays usable from a test", async () => {
  const root = await mkdtemp(join(tmpdir(), "samskara-discovery-nolog-"))

  expect(await globAll(`${root}/missing/**/*.jsonl`)).toEqual([])
})
