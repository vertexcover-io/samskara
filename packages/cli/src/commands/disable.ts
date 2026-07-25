import { resolve } from "node:path"
import type { ProjectIdentity } from "@samskara/core"
import { setProjectEnabled } from "../config/projects.js"
import { resolveLocalProject } from "../project-resolver.js"

interface Writer {
  write(text: string): unknown
}

export type DisableOptions = {
  readonly path?: string
  readonly cwd?: string
  readonly resolveProject?: (path: string) => Promise<ProjectIdentity>
  readonly stdout?: Writer
}

export const disableCommand = async (options: DisableOptions = {}): Promise<number> => {
  const cwd = options.cwd ?? process.cwd()
  const path = resolve(cwd, options.path ?? cwd)
  const project = await (options.resolveProject ?? resolveLocalProject)(path)
  await setProjectEnabled(project.slug, false)
  const stdout = options.stdout ?? process.stdout
  stdout.write(`disabled: ${project.slug}\n`)
  return 0
}
