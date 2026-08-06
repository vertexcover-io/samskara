import { randomUUID } from "node:crypto"
import type { FileSystem } from "./fs.js"
import { type CheckpointStore, checkpointStoreSchema } from "./types.js"

const empty: CheckpointStore = { checkpoints: {} }

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
  const tmp = `${path}.${randomUUID()}.tmp`
  await fs.writeFile(tmp, JSON.stringify(store, null, 2))
  await fs.rename(tmp, path)
}
