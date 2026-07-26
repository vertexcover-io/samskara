import { glob as nodeGlob, readFile, readdir, rename, stat, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { type FileSystem, type ProjectIdentity, createClaudePlugin } from "@samskara/core"
import type pino from "pino"
import { apiBase } from "../config.js"
import { statePath, tokenPath } from "../config/paths.js"
import { isProjectEnabled } from "../config/projects.js"
import { resolveLocalProject } from "../project-resolver.js"
import { type WatcherConfig, type WatcherDeps, runCycle } from "./driver.js"
import { createHttpSink } from "./sink.js"

const CYCLE_MS = 10_000

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

export type WatchOptions = {
  readonly projectOverride?: ProjectIdentity
  readonly log: pino.Logger
}

export const watch = async (options: WatchOptions): Promise<void> => {
  const { log, projectOverride } = options
  const token = await readToken()
  const config: WatcherConfig = { statePath: statePath() }
  // An explicit override captures unconditionally; otherwise only enabled projects.
  const shouldCapture = projectOverride
    ? undefined
    : (project: ProjectIdentity) => isProjectEnabled(project.slug)
  const deps: WatcherDeps = {
    fs: nodeFs,
    clock: { now: () => Date.now() },
    sink: createHttpSink({ apiBase, token, fetch: globalThis.fetch }),
    glob: globAll,
    plugin: createClaudePlugin(nodeFs),
    resolveProject: projectOverride ? async () => projectOverride : resolveLocalProject,
    ...(shouldCapture ? { shouldCapture } : {}),
    log,
  }

  for (;;) {
    await runCycle(config, deps).catch((err: unknown) => {
      log.error({ err }, "Watch cycle failed")
    })
    await sleep(CYCLE_MS)
  }
}
