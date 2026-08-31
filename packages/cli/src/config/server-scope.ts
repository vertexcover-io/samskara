import { copyFile, mkdir, rm } from "node:fs/promises"
import { basename, join } from "node:path"
import { DEFAULT_API_URL } from "../config.js"
import type { Writer } from "../io.js"
import { atomicWriteJson, readJson, withFileLock } from "./atomic.js"
import { deleteToken } from "./credentials.js"
import {
  artifactQueuePath,
  artifactStatePath,
  configHome,
  filterOptionsPath,
  projectsPath,
  statePath,
  tokenPath,
} from "./paths.js"
import { readSettings } from "./settings.js"

export type Mismatch = {
  readonly file: string
  readonly recorded: string
  readonly current: string
}

// Not `apiBase()`: `SAMSKARA_API_URL` is a documented one-off override, and reading it here would
// make a single command look like a server change.
export const persistedApiUrl = (): string => readSettings()?.apiUrl ?? DEFAULT_API_URL

export const stampIn = (value: unknown): string | null => {
  const stamp = (value as { apiBase?: unknown } | null)?.apiBase
  return typeof stamp === "string" && stamp !== "" ? stamp : null
}

export const stampOf = async (path: string): Promise<string | null> => stampIn(await readJson(path))

// A missing stamp is not a mismatch: an unstamped file is adopted as belonging to the current server.
export const scopeMismatch = async (
  paths: ReadonlyArray<string>,
): Promise<ReadonlyArray<Mismatch>> => {
  const current = persistedApiUrl()
  const entries = await Promise.all(
    paths.map(async (file) => ({ file, recorded: await stampOf(file) })),
  )
  return entries
    .filter(
      (entry): entry is { file: string; recorded: string } =>
        entry.recorded !== null && entry.recorded !== current,
    )
    .map(({ file, recorded }) => ({ file, recorded, current }))
}

// Functions, not constants: `paths.ts` re-reads `SAMSKARA_HOME` on every call.
export const TRIPWIRE_PATHS = (): ReadonlyArray<string> => [projectsPath()]

export const ALL_SCOPED_PATHS = (): ReadonlyArray<string> => [
  projectsPath(),
  statePath(),
  artifactStatePath(),
  artifactQueuePath(),
  filterOptionsPath(),
]

export const mismatchFact = (mismatch: Mismatch): string =>
  `Local state was captured against ${mismatch.recorded}, but this CLI is configured for ` +
  `${mismatch.current}.`

// Silent in the daemon: its stderr goes to a crash log nobody reads, so `watch()` logs it instead.
export const warnOnServerChange = async (stderr: Writer): Promise<void> => {
  if (process.env.SAMSKARA_DAEMON === "1") return
  const [mismatch] = await scopeMismatch(TRIPWIRE_PATHS())
  if (mismatch === undefined) return
  stderr.write(`${mismatchFact(mismatch)} Run \`samskara init --force\` to move it across.\n`)
}

// The `preAction` hook stays quiet for these, or every refusal prints two near-identical lines.
export const REFUSES_ON_SERVER_CHANGE: ReadonlySet<string> = new Set([
  "enable",
  "disable",
  "replay",
])

export const refuseOnServerChange = async (stderr: Writer): Promise<boolean> => {
  const [mismatch] = await scopeMismatch(TRIPWIRE_PATHS())
  if (mismatch === undefined) return false
  stderr.write(
    `${mismatchFact(mismatch)} Nothing was changed -- run \`samskara init --force\` first.\n`,
  )
  return true
}

export type ResetDeps = {
  readonly stopWatcher: () => Promise<boolean>
}

export type ResetReport = {
  readonly backupDir: string
  readonly backedUp: ReadonlyArray<string>
  readonly cleared: ReadonlyArray<string>
  readonly projects: number
}

const DERIVED_PATHS = (): ReadonlyArray<string> => [
  statePath(),
  artifactStatePath(),
  artifactQueuePath(),
  filterOptionsPath(),
]

// Direct, not via `projects.ts`: that module imports from here, so calling back would be circular.
const disableProjects = async (): Promise<number> =>
  withFileLock(projectsPath(), async () => {
    const raw = (await readJson(projectsPath())) as
      | { projects?: Record<string, Record<string, unknown>> }
      | undefined
    const projects = raw?.projects ?? {}
    const cleared = Object.fromEntries(
      Object.entries(projects).map(([slug, entry]) => {
        const { projectId: _dropped, ...rest } = entry
        return [slug, { ...rest, enabled: false }]
      }),
    )
    await atomicWriteJson(projectsPath(), {
      version: 1,
      apiBase: persistedApiUrl(),
      projects: cleared,
    })
    return Object.keys(cleared).length
  })

// Order matters: stop, back up, delete. A running watcher rewrites these files under no lock, so a
// copy taken before it stops can catch one mid-rewrite.
export const resetServerScope = async (deps: ResetDeps): Promise<ResetReport> => {
  await deps.stopWatcher()

  const backupDir = join(configHome(), "backups", new Date().toISOString().replace(/:/g, "-"))
  await mkdir(backupDir, { recursive: true })

  const backedUp: string[] = []
  const backUp = async (file: string, name: string): Promise<void> => {
    const copied = await copyFile(file, join(backupDir, name)).then(
      () => true,
      () => false,
    )
    if (copied) backedUp.push(file)
  }
  for (const file of ALL_SCOPED_PATHS()) await backUp(file, basename(file))
  await backUp(tokenPath(), "token")

  const cleared = DERIVED_PATHS()
  for (const file of cleared) {
    await rm(file, { force: true })
  }

  const projects = await disableProjects()
  await deleteToken()

  return { backupDir, backedUp, cleared, projects }
}
