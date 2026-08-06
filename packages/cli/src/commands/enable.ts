import { resolve } from "node:path"
import { reviveWatcher, watcherPid } from "../config/daemon.js"
import { watchLogDir } from "../config/paths.js"
import { getProject, upsertProject } from "../config/projects.js"
import { resolveProject } from "../watcher/resolveProject.js"

interface Writer {
  write(text: string): unknown
}

export type EnableOptions = {
  readonly path?: string
  readonly cwd?: string
  readonly all?: boolean
  readonly syncFrom?: string
  readonly now?: () => Date
  readonly stdout?: Writer
  readonly stderr?: Writer
}

/**
 * `--all` opts into the whole history; an explicit `--sync-from` pins a cutoff; otherwise capture
 * starts now, so enabling an old project does not retroactively upload sessions never opted into.
 */
const cutoffFor = (options: EnableOptions, enabledAt: string): string | undefined | null => {
  if (options.all === true) return undefined
  if (options.syncFrom === undefined) return enabledAt
  const parsed = new Date(options.syncFrom)
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
}

export const enableCommand = async (options: EnableOptions = {}): Promise<number> => {
  const cwd = options.cwd ?? process.cwd()
  const path = resolve(cwd, options.path ?? cwd)
  const project = await resolveProject(path)
  const existing = await getProject(project.slug)
  const stdout = options.stdout ?? process.stdout
  const enabledAt = (options.now ?? (() => new Date()))().toISOString()
  const syncFrom = cutoffFor(options, enabledAt)

  // Validate before branching on enabled state: the already-enabled path changes nothing,
  // so accepting an unreadable date there would silently discard what the user asked for.
  if (syncFrom === null) {
    const stderr = options.stderr ?? process.stderr
    stderr.write(
      `Could not read "${options.syncFrom}" as a date, so "${project.slug}" was not enabled. Pass a date like 2026-07-01 or 2026-07-01T00:00:00Z.\n`,
    )
    return 1
  }

  if (existing?.enabled === true) {
    stdout.write(
      `Capture is already enabled for "${project.slug}" (since ${existing.enabledAt}). Nothing to change.\n`,
    )
  } else {
    await upsertProject(project.slug, {
      name: project.name,
      path,
      enabled: true,
      enabledAt,
      ...(syncFrom === undefined ? {} : { syncFrom }),
    })
    stdout.write(
      syncFrom === undefined
        ? `Capture enabled for "${project.slug}" at ${path}, including sessions recorded earlier.\n`
        : `Capture enabled for "${project.slug}" at ${path}, for sessions started after ${syncFrom}.\n`,
    )
  }

  if (watcherPid() === null) {
    const pid = await reviveWatcher()
    const stderr = options.stderr ?? process.stderr
    if (pid === null) {
      stderr.write(
        `The capture watcher could not be started, so sessions will not be recorded. See the logs in ${watchLogDir()} for the reason.\n`,
      )
    } else {
      stdout.write(
        `Started the capture watcher (process ${pid}). Its logs are in ${watchLogDir()}.\n`,
      )
    }
  }
  return 0
}
