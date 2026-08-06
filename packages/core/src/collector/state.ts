import { randomUUID } from "node:crypto"
import type { FileSystem } from "./fs.js"
import { type CheckpointStore, checkpointStoreSchema } from "./types.js"

const empty: CheckpointStore = { checkpoints: {} }

/**
 * Empty for a store that is absent, which is every first run. A store that is present but will not
 * parse throws instead, because answering empty resyncs every session from its first line -- the
 * caller decides how loudly that lands, since this module has no logger of its own.
 */
export const readCheckpoints = async (fs: FileSystem, path: string): Promise<CheckpointStore> => {
  const text = await fs.readFile(path).catch(() => null)
  if (text === null) return empty
  return checkpointStoreSchema.parse(JSON.parse(text))
}

export const writeCheckpoints = async (
  fs: FileSystem,
  path: string,
  store: CheckpointStore,
): Promise<void> => {
  // Unique per write: a fixed `${path}.tmp` lets two writers share one scratch file, so one can
  // rename the other's half-written bytes into place -- which is how this store becomes the
  // unparseable file `readCheckpoints` now reports.
  const tmp = `${path}.${randomUUID()}.tmp`
  await fs.writeFile(tmp, JSON.stringify(store, null, 2))
  await fs.rename(tmp, path)
}
