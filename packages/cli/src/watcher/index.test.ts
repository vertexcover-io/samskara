import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, test, vi } from "vitest"
import { artifactDeps, drainWorkers, globAll } from "./index.js"

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

test("the daemon's artifact deps point into the active samskara home and resolve symlinks", async () => {
  const home = await mkdtemp(join(tmpdir(), "samskara-artifact-deps-"))
  process.env.SAMSKARA_HOME = home

  const deps = artifactDeps()

  expect(deps.queuePath).toBe(join(home, "artifact-queue.json"))
  expect(deps.statePath).toBe(join(home, "artifacts.json"))

  // `stat` and `realpath` are the cycle's only disk contact with an artifact: a symlink must
  // resolve to its target so containment judges the real file, and `stat` must report its size.
  const target = join(home, "real.md")
  const link = join(home, "link.md")
  await writeFile(target, "hello", "utf8")
  await symlink(target, link)

  expect(await deps.realpath(link)).toBe(await deps.realpath(target))
  expect((await deps.stat(target)).size).toBe(5)
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
