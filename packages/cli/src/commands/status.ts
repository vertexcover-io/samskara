import { checkpointStoreSchema } from "@samskara/core"
import { readJson } from "../config/atomic.js"
import { watcherPid as readWatcherPid } from "../config/daemon.js"
import { statePath, watchLogPath } from "../config/paths.js"
import { listProjects } from "../config/projects.js"

interface Writer {
  write(text: string): unknown
}

export type StatusOptions = {
  readonly watcherPid?: () => number | null
  readonly stdout?: Writer
}

const latestSyncBySlug = async (): Promise<ReadonlyMap<string, string>> => {
  const parsed = checkpointStoreSchema.safeParse(await readJson(statePath()))
  if (!parsed.success) return new Map()
  const latest = new Map<string, string>()
  for (const checkpoint of Object.values(parsed.data.checkpoints)) {
    if (!checkpoint.projectSlug) continue
    const current = latest.get(checkpoint.projectSlug)
    if (!current || checkpoint.lastUpdatedAt > current) {
      latest.set(checkpoint.projectSlug, checkpoint.lastUpdatedAt)
    }
  }
  return latest
}

export const statusCommand = async (options: StatusOptions = {}): Promise<number> => {
  const stdout = options.stdout ?? process.stdout
  const projects = [...(await listProjects())].sort((a, b) => a.slug.localeCompare(b.slug))
  const lastSync = await latestSyncBySlug()
  if (projects.length === 0) {
    stdout.write("No projects registered.\n")
  } else {
    stdout.write("SLUG\tNAME\tPATH\tSTATUS\tENABLED AT\tLAST SYNC\n")
    for (const { slug, entry } of projects) {
      const status = entry.enabled ? "enabled" : "disabled"
      stdout.write(
        `${slug}\t${entry.name}\t${entry.path}\t${status}\t${entry.enabledAt}\t${lastSync.get(slug) ?? "-"}\n`,
      )
    }
  }
  const pid = (options.watcherPid ?? (() => readWatcherPid()))()
  stdout.write(`watcher: ${pid === null ? "stopped" : `running (pid ${pid})`}\n`)
  stdout.write(`logs: ${watchLogPath()}\n`)
  return 0
}
