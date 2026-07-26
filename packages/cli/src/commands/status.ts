import { checkpointStoreSchema } from "@samskara/core"
import { readJson } from "../config/atomic.js"
import { readToken } from "../config/credentials.js"
import { watcherPid } from "../config/daemon.js"
import { statePath, watchLogDir } from "../config/paths.js"
import { listProjects } from "../config/projects.js"
import { verifyToken } from "../login.js"

interface Writer {
  write(text: string): unknown
}

export type StatusOptions = {
  readonly stdout?: Writer
}

const authLine = async (): Promise<string> => {
  const token = await readToken()
  if (!token) {
    return "Account: this CLI is not paired with an account yet. Run `samskara login` to pair it."
  }
  try {
    const identity = await verifyToken(token)
    return `Account: paired as ${identity.githubLogin}.`
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return `Account: the saved token is no longer accepted, so captured sessions cannot be uploaded. ${reason} Run \`samskara login\` to pair again.`
  }
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
    stdout.write(
      "No projects are registered yet. Run `samskara enable` inside a project folder to start capturing its sessions.\n",
    )
  } else {
    stdout.write("SLUG\tNAME\tPATH\tSTATUS\tENABLED AT\tLAST SYNC\n")
    for (const { slug, entry } of projects) {
      const status = entry.enabled ? "enabled" : "disabled"
      stdout.write(
        `${slug}\t${entry.name}\t${entry.path}\t${status}\t${entry.enabledAt}\t${lastSync.get(slug) ?? "-"}\n`,
      )
    }
  }
  stdout.write(`${await authLine()}\n`)
  const pid = watcherPid()
  stdout.write(
    pid === null
      ? "Watcher: not running, so new sessions are not being captured. Run `samskara enable` to start it.\n"
      : `Watcher: running as process ${pid}.\n`,
  )
  stdout.write(`Watcher logs: ${watchLogDir()}\n`)
  return 0
}
