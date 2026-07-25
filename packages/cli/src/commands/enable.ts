import { resolve } from "node:path"
import type { ProjectIdentity } from "@samskara/core"
import { upsertProject } from "../config/projects.js"
import { resolveLocalProject } from "../project-resolver.js"

interface Writer {
  write(text: string): unknown
}

export type EnableOptions = {
  readonly path?: string
  readonly cwd?: string
  readonly now?: () => Date
  readonly resolveProject?: (path: string) => Promise<ProjectIdentity>
  readonly stdout?: Writer
}

export const enableCommand = async (options: EnableOptions = {}): Promise<number> => {
  const cwd = options.cwd ?? process.cwd()
  const path = resolve(cwd, options.path ?? cwd)
  const project = await (options.resolveProject ?? resolveLocalProject)(path)
  const enabledAt = (options.now ?? (() => new Date()))().toISOString()
  await upsertProject(project.slug, {
    name: project.name,
    path,
    enabled: true,
    enabledAt,
  })
  const stdout = options.stdout ?? process.stdout
  stdout.write(`enabled: ${project.slug}\n`)
  return 0
}
