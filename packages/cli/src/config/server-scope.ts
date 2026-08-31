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

/**
 * Deliberately reads the settings file, not `apiBase()`: `SAMSKARA_API_URL` is a documented one-off
 * override (`config.ts`), and treating it as "the server changed" would reset state for a single
 * command.
 */
export const persistedApiUrl = (): string => readSettings()?.apiUrl ?? DEFAULT_API_URL

/** For a caller that has already read the file and should not read it a second time. */
export const stampIn = (value: unknown): string | null => {
  const stamp = (value as { apiBase?: unknown } | null)?.apiBase
  return typeof stamp === "string" && stamp !== "" ? stamp : null
}

export const stampOf = async (path: string): Promise<string | null> => stampIn(await readJson(path))

/**
 * A missing stamp is not a mismatch: it is what a file predating this feature, or a file that does
 * not exist yet, looks like. Both are adopted as belonging to the current server rather than tripping
 * the check.
 */
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

// Functions, not module-level constants: `paths.ts` reads `SAMSKARA_HOME` on every call, so a test
// pointing it at a temp directory needs these re-evaluated too.
export const TRIPWIRE_PATHS = (): ReadonlyArray<string> => [projectsPath()]

export const ALL_SCOPED_PATHS = (): ReadonlyArray<string> => [
  projectsPath(),
  statePath(),
  artifactStatePath(),
  artifactQueuePath(),
  filterOptionsPath(),
]

/**
 * The half every caller shares: what is true. What to do about it differs by caller and is written
 * out there in full, rather than passed in as a trailing fragment -- `"first."` on its own says
 * nothing at a call site, and a sentence assembled across a seam cannot be read from either end.
 */
export const mismatchFact = (mismatch: Mismatch): string =>
  `Local state was captured against ${mismatch.recorded}, but this CLI is configured for ` +
  `${mismatch.current}.`

/**
 * Read-only commands call this. The daemon suppresses it: `daemon.ts` spawns the watcher as a child
 * running the whole CLI again with `SAMSKARA_DAEMON=1`, and that child's stderr is redirected to a
 * crash log nobody reads -- a warning there is effectively invisible, so `watch()` reports the same
 * condition its own way instead.
 */
export const warnOnServerChange = async (stderr: Writer): Promise<void> => {
  if (process.env.SAMSKARA_DAEMON === "1") return
  const [mismatch] = await scopeMismatch(TRIPWIRE_PATHS())
  if (mismatch === undefined) return
  stderr.write(`${mismatchFact(mismatch)} Run \`samskara init --force\` to move it across.\n`)
}

/**
 * The commands calling `refuseOnServerChange` below. The `preAction` hook stays quiet for these, or
 * it would print its own warning immediately before the refusal prints a near-identical one. Adding
 * a command to `refuseOnServerChange` means adding it here; `SC27` fails if the two drift apart.
 */
export const REFUSES_ON_SERVER_CHANGE: ReadonlySet<string> = new Set([
  "enable",
  "disable",
  "replay",
])

/**
 * Commands that write a derived file call this. `enable` rewrites the whole of `projects.json` with
 * a fresh `apiBase`, so writing anything at all would re-stamp the file to the new server while
 * other entries still hold the old server's `projectId` -- the mismatch would erase itself.
 */
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
  /** What was copied. Not every scoped file exists on a given install. */
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

/**
 * Reads and rewrites `projects.json` directly rather than through `projects.ts`'s writers: that
 * module already imports `persistedApiUrl` from here, and a reset calling back into it would make
 * the two files import each other. `replay.ts` clears its three files the same direct way for the
 * same reason. Loose types on purpose -- this only strips one key and flips one flag, on whatever
 * shape the file already holds.
 */
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

/**
 * The only place in the CLI that deletes derived state, and only `init --force` calls it. Order is
 * not interchangeable: stop, then back up, then delete. A running watcher holds these same files
 * with no lock and rewrites them after its own upload flush (`driver.ts:322,368`;
 * `state.ts:7,13`), so backing up before it stops can catch a file mid-rewrite -- `replay.ts` stops
 * the watcher for the identical reason.
 */
export const resetServerScope = async (deps: ResetDeps): Promise<ResetReport> => {
  await deps.stopWatcher()

  const backupDir = join(configHome(), "backups", new Date().toISOString().replace(/:/g, "-"))
  await mkdir(backupDir, { recursive: true })

  // Records what landed rather than what was looked for: most of these files are absent on any
  // given install, and the count is printed to say the data is safe immediately before it is
  // deleted. A number describing the attempt would overstate that at the worst possible moment.
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
