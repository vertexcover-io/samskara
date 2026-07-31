import {
  glob as nodeGlob,
  readFile,
  readdir,
  realpath,
  rename,
  stat,
  writeFile,
} from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { type FileSystem, type ProjectIdentity, createClaudePlugin } from "@samskara/core"
import type pino from "pino"
import { apiBase } from "../config.js"
import {
  artifactQueuePath,
  artifactStatePath,
  fileHistoryDir,
  statePath,
  tokenPath,
} from "../config/paths.js"
import { isProjectEnabled, syncFromFor } from "../config/projects.js"
import { resolveLocalProject } from "../project-resolver.js"
import { runArtifactWorkers } from "./artifact-worker.js"
import { type ArtifactCycleDeps, type WatcherConfig, type WatcherDeps, runCycle } from "./driver.js"
import { createArtifactSink, createHttpSink } from "./sink.js"

const CYCLE_MS = 10_000
const SHUTDOWN_GRACE_MS = 5_000

const expandHome = (pattern: string): string =>
  pattern.startsWith("~/") ? join(homedir(), pattern.slice(2)) : pattern

const nodeFs: FileSystem = {
  readFile: (path) => readFile(path, "utf8"),
  writeFile: (path, data) => writeFile(path, data, "utf8"),
  rename,
  stat: async (path) => {
    const s = await stat(path)
    return { size: s.size, mtimeMs: s.mtimeMs }
  },
}

const listJsonl = async (dir: string): Promise<ReadonlyArray<string>> => {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    const nested = await Promise.all(
      entries.map((entry): Promise<ReadonlyArray<string>> => {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) return listJsonl(path)
        return Promise.resolve(entry.isFile() && entry.name.endsWith(".jsonl") ? [path] : [])
      }),
    )
    return nested.flat()
  } catch {
    return []
  }
}

export const globAll = async (pattern: string): Promise<ReadonlyArray<string>> => {
  const expanded = expandHome(pattern)
  const recursiveJsonl = expanded.match(/^(.*)[\\/]\*\*[\\/]\*\.jsonl$/)
  const root = recursiveJsonl?.[1]
  if (root) return listJsonl(root)

  const matches: string[] = []
  for await (const entry of nodeGlob(expanded)) matches.push(entry)
  return matches
}

const readToken = async (): Promise<string> => {
  const token = (await readFile(tokenPath(), "utf8")).trim()
  if (!token) throw new Error("no token found; run `samskara login` first")
  return token
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Resolved per run rather than at module load: SAMSKARA_HOME is read at call time, so the
 * daemon writes its queue under whichever home the process was started with.
 */
export const artifactDeps = (): ArtifactCycleDeps => ({
  queuePath: artifactQueuePath(),
  statePath: artifactStatePath(),
  realpath,
  stat: async (path) => {
    const s = await stat(path)
    return { size: s.size, mtimeMs: s.mtimeMs }
  },
})

export type WatchOptions = {
  readonly projectOverride?: ProjectIdentity
  readonly log: pino.Logger
}

/**
 * Races the in-flight workers against a grace deadline and calls `onDrained` once, whichever
 * settles first. Extracted so the race itself -- the part that decides whether a slow upload
 * gets torn down mid-write or is allowed to finish -- is testable without real signals, a real
 * process, or a real worker pool.
 */
export const drainWorkers = (
  workers: Promise<unknown>,
  graceMs: number,
  sleep: (ms: number) => Promise<void>,
  onDrained: () => void,
): Promise<void> => Promise.race([workers, sleep(graceMs)]).then(onDrained)

export const watch = async (options: WatchOptions): Promise<void> => {
  const { log, projectOverride } = options
  const token = await readToken()
  const config: WatcherConfig = { statePath: statePath() }
  // An explicit override captures unconditionally; otherwise only enabled projects, and only
  // sessions started after the project's cutoff.
  const shouldCapture = projectOverride
    ? undefined
    : (project: ProjectIdentity) => isProjectEnabled(project.slug)
  const cutoffFor = projectOverride
    ? undefined
    : (project: ProjectIdentity) => syncFromFor(project.slug)
  const deps: WatcherDeps = {
    fs: nodeFs,
    clock: { now: () => Date.now() },
    sink: createHttpSink({ apiBase, token, fetch: globalThis.fetch }),
    glob: globAll,
    plugin: createClaudePlugin(nodeFs),
    resolveProject: projectOverride ? async () => projectOverride : resolveLocalProject,
    ...(shouldCapture ? { shouldCapture } : {}),
    ...(cutoffFor ? { syncFromFor: cutoffFor } : {}),
    artifacts: artifactDeps(),
    log,
  }

  // Started before the loop, never inside it: awaiting the workers each iteration would
  // reintroduce exactly the stall this design exists to avoid -- a 50 MB video would block
  // transcript ingestion for minutes.
  let stopping = false
  const workers = runArtifactWorkers(
    { queuePath: artifactQueuePath(), statePath: artifactStatePath() },
    {
      fileHistoryDir: fileHistoryDir(),
      log,
      sink: createArtifactSink({ apiBase, token, fetch: globalThis.fetch }),
      clock: { now: () => Date.now() },
      stopped: () => stopping,
    },
  ).catch((err: unknown) => {
    log.error({ err }, "Artifact workers stopped")
  })

  // Stop claiming new entries, give in-flight uploads their grace, then exit. Unfinished
  // entries persist in the queue file and resume on the next start.
  const shutdown = (signal: NodeJS.Signals) => {
    stopping = true
    log.info({ signal }, "Shutting down; draining in-flight artifact uploads")
    void drainWorkers(workers, SHUTDOWN_GRACE_MS, sleep, () => process.exit(0))
  }
  process.once("SIGINT", shutdown)
  process.once("SIGTERM", shutdown)

  for (;;) {
    if (stopping) return
    await runCycle(config, deps).catch((err: unknown) => {
      log.error({ err }, "Watch cycle failed")
    })
    await sleep(CYCLE_MS)
  }
}
