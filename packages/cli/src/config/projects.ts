import { z } from "zod"
import { atomicWriteJson, readJson, withFileLock } from "./atomic.js"
import { projectsPath } from "./paths.js"

const projectEntrySchema = z
  .object({
    name: z.string().min(1),
    path: z.string().min(1),
    enabled: z.boolean(),
    enabledAt: z.string().datetime(),
    syncFrom: z.string().datetime().optional(),
  })
  .strict()
  .readonly()

const projectsFileSchema = z
  .object({
    version: z.literal(1),
    projects: z.record(z.string(), projectEntrySchema),
  })
  .strict()
  .readonly()

export type ProjectEntry = z.infer<typeof projectEntrySchema>
export type ProjectsFile = z.infer<typeof projectsFileSchema>
export type RegisteredProject = {
  readonly slug: string
  readonly entry: ProjectEntry
}

const emptyProjects = (): ProjectsFile => ({ version: 1, projects: {} })

const readProjects = async (): Promise<ProjectsFile> => {
  const parsed = projectsFileSchema.safeParse(await readJson(projectsPath()))
  return parsed.success ? parsed.data : emptyProjects()
}

export const listProjects = async (): Promise<ReadonlyArray<RegisteredProject>> => {
  const file = await readProjects()
  return Object.entries(file.projects).map(([slug, entry]) => ({ slug, entry }))
}

export const getProject = async (slug: string): Promise<ProjectEntry | null> => {
  const file = await readProjects()
  return file.projects[slug] ?? null
}

export const isProjectEnabled = async (slug: string): Promise<boolean> =>
  (await getProject(slug))?.enabled === true

export const syncFromFor = async (slug: string): Promise<string | undefined> =>
  (await getProject(slug))?.syncFrom

export const upsertProject = async (slug: string, entry: ProjectEntry): Promise<ProjectEntry> =>
  withFileLock(projectsPath(), async () => {
    const current = await readProjects()
    const next: ProjectsFile = {
      version: 1,
      projects: { ...current.projects, [slug]: entry },
    }
    await atomicWriteJson(projectsPath(), next)
    return entry
  })

export const setProjectEnabled = async (
  slug: string,
  enabled: boolean,
): Promise<ProjectEntry | null> =>
  withFileLock(projectsPath(), async () => {
    const current = await readProjects()
    const existing = current.projects[slug]
    if (!existing) return null
    const nextEntry: ProjectEntry = { ...existing, enabled }
    await atomicWriteJson(projectsPath(), {
      version: 1,
      projects: { ...current.projects, [slug]: nextEntry },
    })
    return nextEntry
  })
