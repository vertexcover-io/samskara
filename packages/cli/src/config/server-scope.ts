import { DEFAULT_API_URL } from "../config.js"
import type { Writer } from "../io.js"
import { readJson } from "./atomic.js"
import {
  artifactQueuePath,
  artifactStatePath,
  filterOptionsPath,
  projectsPath,
  statePath,
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

export const stampOf = async (path: string): Promise<string | null> => {
  const value = await readJson(path)
  const stamp = (value as { apiBase?: unknown } | null)?.apiBase
  return typeof stamp === "string" && stamp !== "" ? stamp : null
}

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

const mismatchLine = (mismatch: Mismatch, fix: string): string =>
  `Local state was captured against ${mismatch.recorded}, but this CLI is configured for ` +
  `${mismatch.current}. Run \`samskara init --force\` ${fix}\n`

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
  stderr.write(mismatchLine(mismatch, "to move it across."))
}

/**
 * Commands that write a derived file call this. `enable` rewrites the whole of `projects.json` with
 * a fresh `apiBase`, so writing anything at all would re-stamp the file to the new server while
 * other entries still hold the old server's `projectId` -- the mismatch would erase itself.
 */
export const refuseOnServerChange = async (stderr: Writer): Promise<boolean> => {
  const [mismatch] = await scopeMismatch(TRIPWIRE_PATHS())
  if (mismatch === undefined) return false
  stderr.write(mismatchLine(mismatch, "first."))
  return true
}
