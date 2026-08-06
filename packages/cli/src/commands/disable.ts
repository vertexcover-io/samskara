import { resolve } from "node:path"
import type { ProjectIdentity } from "@samskara/core"
import { setProjectEnabled } from "../config/projects.js"
import { type Writer, resolveIo } from "../io.js"
import { resolveProject } from "../watcher/resolveProject.js"

export type DisableOptions = {
  readonly path?: string
  readonly cwd?: string
  readonly resolveProject?: (path: string) => Promise<ProjectIdentity>
  readonly stdout?: Writer
}

export const disableCommand = async (options: DisableOptions = {}): Promise<number> => {
  const cwd = options.cwd ?? process.cwd()
  const path = resolve(cwd, options.path ?? cwd)
  const project = await (options.resolveProject ?? resolveProject)(path)
  const updated = await setProjectEnabled(project.slug, false)
  const { stdout } = resolveIo(options)
  if (updated === null) {
    stdout.write(
      `Capture was never enabled for "${project.slug}", so there is nothing to disable.\n`,
    )
    return 0
  }
  stdout.write(`Capture disabled for "${project.slug}". Existing captured sessions are kept.\n`)
  return 0
}
