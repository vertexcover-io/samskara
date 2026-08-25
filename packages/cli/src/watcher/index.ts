import { glob as nodeGlob, readdir, readFile, rename, stat, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { createClaudePlugin, type FileSystem, type ProjectIdentity } from "@samskara/core"
import type pino from "pino"
import { readToken } from "../config/credentials.js"
import { artifactQueuePath, artifactStatePath, fileHistoryDir, statePath } from "../config/paths.js"
import { getProject, isProjectEnabled, syncFromFor } from "../config/projects.js"
import { apiBase } from "../config.js"
import { sleep } from "../io.js"
import { runArtifactWorkers } from "./artifact-worker.js"
import { runCycle, type WatcherConfig, type WatcherDeps } from "./driver.js"
import { resolveProject } from "./resolveProject.js"
import { createArtifactSink, createHttpSink } from "./sink.js"

const CYCLE_MS = 10_000
const SHUTDOWN_GRACE_MS = 5_000

const expandHome = (pattern: string): string =>
  pattern.startsWith("~/") ? join(homedir(), pattern.slice(2)) : pattern

const statOf = async (
  path: string,
): Promise<{ readonly size: number; readonly mtimeMs: number }> => {
  const { size, mtimeMs } = await stat(path)
  return { size, mtimeMs }
}

const nodeFs: FileSystem = {
  readFile: (path) => readFile(path, "utf8"),
  writeFile: (path, data) => writeFile(path, data, "utf8"),
  rename,
  stat: statOf,
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

export type WatchOptions = {
  readonly projectOverride?: ProjectIdentity
  readonly log: pino.Logger
}

/**
 * A daemon that cached the identity before `enable` ran (`claude.ts`'s per-directory cache)
 * keeps sending no id until it restarts -- the server's owner rule picks the same project in
 * that case, so nothing is lost.
 */
export const withStoredProjectId = async (identity: ProjectIdentity): Promise<ProjectIdentity> => {
  const stored = (await getProject(identity.slug))?.projectId
  return stored === undefined ? identity : { ...identity, projectId: stored }
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
  // Checked once so a daemon with no credentials at all fails loudly at startup; the sinks read
  // the token again on every request, so a later `samskara login` lands without a restart.
  if (!(await readToken())) throw new Error("no token found; run `samskara login` first")
  // Read at call time, not module load: SAMSKARA_HOME decides where the queue lives, and the
  // daemon must write under whichever home the process was started with.
  const config: WatcherConfig = { statePath: statePath(), artifactQueuePath: artifactQueuePath() }
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
    sink: createHttpSink({ apiBase: apiBase(), readToken, fetch: globalThis.fetch }),
    glob: globAll,
    plugin: createClaudePlugin(nodeFs),
    resolveProject: projectOverride
      ? async () => projectOverride
      : async (dir) => withStoredProjectId(await resolveProject(dir)),
    ...(shouldCapture ? { shouldCapture } : {}),
    ...(cutoffFor ? { syncFromFor: cutoffFor } : {}),
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
      sink: createArtifactSink({ apiBase: apiBase(), readToken, fetch: globalThis.fetch }),
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
