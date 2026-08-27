import { resolve } from "node:path"
import type { ProjectIdentity } from "@samskara/core"
import { setProjectEnabled } from "../config/projects.js"
import { resolveIo, type Writer } from "../io.js"
import { resolveProject } from "../watcher/resolveProject.js"

export type DisableOptions = {
  readonly path?: string
  readonly cwd?: string
  readonly resolveProject?: (path: string) => Promise<ProjectIdentity | null>
  readonly stdout?: Writer
  readonly stderr?: Writer
}

export const disableCommand = async (options: DisableOptions = {}): Promise<number> => {
  const cwd = options.cwd ?? process.cwd()
  const path = resolve(cwd, options.path ?? cwd)
  const project = await (options.resolveProject ?? resolveProject)(path)
  const { stdout, stderr } = resolveIo(options)
  if (project === null) {
    stderr.write(`There is no directory at "${path}", so there is nothing to disable.\n`)
    return 1
  }
  const updated = await setProjectEnabled(project.slug, false)
  if (updated === null) {
    stdout.write(
      `Capture was never enabled for "${project.slug}", so there is nothing to disable.\n`,
    )
    return 0
  }
  stdout.write(`Capture disabled for "${project.slug}". Existing captured sessions are kept.\n`)
  return 0
}
