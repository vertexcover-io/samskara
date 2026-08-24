import { homedir } from "node:os"
import { checkpointStoreSchema } from "@samskara/core"
import { readValidated } from "../config/atomic.js"
import { readToken } from "../config/credentials.js"
import { watcherPid } from "../config/daemon.js"
import { statePath, watchLogDir } from "../config/paths.js"
import { listProjects } from "../config/projects.js"
import { resolveIo, type Writer } from "../io.js"
import { verifyToken } from "../login.js"

export type StatusOptions = {
  readonly stdout?: Writer
  readonly now?: () => Date
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

const shortenPath = (path: string): string =>
  path.startsWith(homedir()) ? `~${path.slice(homedir().length)}` : path

const relativeTime = (iso: string, now: Date): string => {
  const elapsed = now.getTime() - new Date(iso).getTime()
  if (Number.isNaN(elapsed)) return iso
  if (elapsed < MINUTE) return "just now"
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m ago`
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h ago`
  if (elapsed < 30 * DAY) return `${Math.floor(elapsed / DAY)}d ago`
  return iso.slice(0, 10)
}

const authLine = async (): Promise<string> => {
  const token = await readToken()
  if (!token) return "not paired -- run `samskara login` to pair this CLI"
  try {
    return `paired as ${(await verifyToken(token)).githubLogin}`
  } catch {
    return "token rejected -- sessions cannot be uploaded\n           re-pair with `samskara login`"
  }
}

const latestSyncBySlug = async (): Promise<ReadonlyMap<string, string>> => {
  const store = (await readValidated(statePath(), checkpointStoreSchema)) ?? { checkpoints: {} }
  const latest = new Map<string, string>()
  for (const checkpoint of Object.values(store.checkpoints)) {
    if (!checkpoint.projectSlug) continue
    const current = latest.get(checkpoint.projectSlug)
    if (!current || checkpoint.lastUpdatedAt > current) {
      latest.set(checkpoint.projectSlug, checkpoint.lastUpdatedAt)
    }
  }
  return latest
}

export const statusCommand = async (options: StatusOptions = {}): Promise<number> => {
  const { stdout } = resolveIo(options)
  const now = (options.now ?? (() => new Date()))()
  const projects = [...(await listProjects())].sort((a, b) => a.slug.localeCompare(b.slug))
  // Reported inline rather than thrown: `status` is the command someone runs to find out what is
  // wrong, so it has to keep printing everything else it knows.
  const lastSync = await latestSyncBySlug().catch(() => {
    stdout.write(
      `Sync state ${shortenPath(statePath())} is unreadable -- times below are omitted\n`,
    )
    return new Map<string, string>()
  })

  const pid = watcherPid()
  stdout.write(
    pid === null
      ? "Watcher    not running -- new sessions are not being captured\n           start it with `samskara enable`\n"
      : `Watcher    running (pid ${pid})\n`,
  )
  stdout.write(`Account    ${await authLine()}\n`)
  stdout.write(`Logs       ${shortenPath(watchLogDir())}\n\n`)

  if (projects.length === 0) {
    stdout.write("No projects registered yet.\n")
    stdout.write("Run `samskara enable` inside a project folder to start capturing its sessions.\n")
    return 0
  }

  stdout.write(`Projects (${projects.length})\n`)
  for (const { slug, entry } of projects) {
    const synced = lastSync.get(slug)
    stdout.write(`\n  ${entry.enabled ? "●" : "○"} ${entry.name}  (${slug})\n`)
    stdout.write(`      path     ${shortenPath(entry.path)}\n`)
    stdout.write(
      `      capture  ${entry.enabled ? "enabled" : "disabled"} since ${relativeTime(entry.enabledAt, now)}\n`,
    )
    stdout.write(
      `      synced   ${synced ? relativeTime(synced, now) : "never -- no sessions uploaded yet"}\n`,
    )
  }
  return 0
}
