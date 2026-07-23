import { execFile } from "node:child_process"
import { glob as nodeGlob, readFile, rename, stat, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { type FileSystem, type ProjectIdentity, createClaudePlugin } from "@samskara/core"
import type pino from "pino"
import { apiBase } from "../config.js"
import { type WatcherConfig, type WatcherDeps, runCycle } from "./driver.js"
import { type GitRunner, resolveProject } from "./resolveProject.js"
import { createHttpSink } from "./sink.js"

const CYCLE_MS = 10_000
const execFileAsync = promisify(execFile)

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

const globAll = async (pattern: string): Promise<ReadonlyArray<string>> => {
  const matches: string[] = []
  for await (const entry of nodeGlob(expandHome(pattern))) matches.push(entry)
  return matches
}

const runGit: GitRunner = async (args, cwd) => {
  try {
    const { stdout } = await execFileAsync("git", [...args], { cwd })
    return stdout.trim()
  } catch {
    return null
  }
}

const readToken = async (): Promise<string> => {
  const path = join(homedir(), ".samskara", "token")
  const token = (await readFile(path, "utf8")).trim()
  if (!token) throw new Error("no token found; run `samskara login` first")
  return token
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export type WatchOptions = {
  readonly projectOverride?: ProjectIdentity
  readonly log: pino.Logger
}

export const watch = async (options: WatchOptions): Promise<void> => {
  const { log } = options
  const token = await readToken()
  const config: WatcherConfig = {
    statePath: join(homedir(), ".samskara", "state.json"),
    projectOverride: options.projectOverride,
  }
  const deps: WatcherDeps = {
    fs: nodeFs,
    clock: { now: () => Date.now() },
    sink: createHttpSink({ apiBase, token, fetch: globalThis.fetch }),
    glob: globAll,
    plugin: createClaudePlugin(nodeFs),
    resolveProject: (startDir) => resolveProject(startDir, { runGit }),
    log,
  }

  for (;;) {
    await runCycle(config, deps).catch((err: unknown) => {
      log.error({ err }, "Watch cycle failed")
    })
    await sleep(CYCLE_MS)
  }
}
