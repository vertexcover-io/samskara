import { resolve } from "node:path"
import { reviveWatcher } from "../config/daemon.js"
import { watchLogDir } from "../config/paths.js"
import { getProject, upsertProject } from "../config/projects.js"
import { type Writer, resolveIo } from "../io.js"
import { resolveProject } from "../watcher/resolveProject.js"

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
  const { stdout, stderr } = resolveIo(options)
  const enabledAt = (options.now ?? (() => new Date()))().toISOString()
  const syncFrom = cutoffFor(options, enabledAt)

  // Validate before branching on enabled state: the already-enabled path changes nothing,
  // so accepting an unreadable date there would silently discard what the user asked for.
  if (syncFrom === null) {
    stderr.write(
      `Could not read "${options.syncFrom}" as a date, so "${project.slug}" was not enabled. Pass a date like 2026-07-01 or 2026-07-01T00:00:00Z.\n`,
    )
    return 1
  }

  // A bare re-enable is a no-op so an accidental second run cannot move the cutoff forward and
  // silently drop sessions. A cutoff flag is not accidental, so it wins even when already
  // enabled -- otherwise the only way to widen a cutoff is `disable` then `enable`.
  const askedForCutoff = options.all === true || options.syncFrom !== undefined
  if (existing?.enabled === true && !askedForCutoff) {
    stdout.write(
      `Capture is already enabled for "${project.slug}" (since ${existing.enabledAt}). Nothing to change.\n`,
    )
  } else {
    // Re-enabling keeps the original opt-in date: `enabledAt` records when capture was first
    // asked for, and only `syncFrom` says what is eligible.
    const since = existing?.enabled === true ? existing.enabledAt : enabledAt
    await upsertProject(project.slug, {
      name: project.name,
      path,
      enabled: true,
      enabledAt: since,
      ...(syncFrom === undefined ? {} : { syncFrom }),
    })
    stdout.write(
      syncFrom === undefined
        ? `Capture enabled for "${project.slug}" at ${path}, including sessions recorded earlier.\n`
        : `Capture enabled for "${project.slug}" at ${path}, for sessions started after ${syncFrom}.\n`,
    )
  }

  // `reviveWatcher` returns the running pid when there is one, so the message says what is true
  // afterwards rather than claiming this call started it.
  const pid = await reviveWatcher()
  if (pid === null) {
    stderr.write(
      `The capture watcher could not be started, so sessions will not be recorded. See the logs in ${watchLogDir()} for the reason.\n`,
    )
  } else {
    stdout.write(
      `The capture watcher is running (process ${pid}). Its logs are in ${watchLogDir()}.\n`,
    )
  }
  return 0
}
