import { resolve } from "node:path"
import { reviveWatcher, watcherPid } from "../config/daemon.js"
import { watchLogDir } from "../config/paths.js"
import { getProject, upsertProject } from "../config/projects.js"
import { resolveLocalProject } from "../project-resolver.js"

interface Writer {
  write(text: string): unknown
}

export type EnableOptions = {
  readonly path?: string
  readonly cwd?: string
  readonly now?: () => Date
  readonly stdout?: Writer
  readonly stderr?: Writer
}

export const enableCommand = async (options: EnableOptions = {}): Promise<number> => {
  const cwd = options.cwd ?? process.cwd()
  const path = resolve(cwd, options.path ?? cwd)
  const project = await resolveLocalProject(path)
  const existing = await getProject(project.slug)
  const stdout = options.stdout ?? process.stdout

  if (existing?.enabled === true) {
    stdout.write(
      `Capture is already enabled for "${project.slug}" (since ${existing.enabledAt}). Nothing to change.\n`,
    )
  } else {
    const enabledAt = (options.now ?? (() => new Date()))().toISOString()
    await upsertProject(project.slug, { name: project.name, path, enabled: true, enabledAt })
    stdout.write(`Capture enabled for "${project.slug}" at ${path}.\n`)
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
