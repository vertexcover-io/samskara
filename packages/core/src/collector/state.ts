import type { FileSystem } from "./fs.js"
import { type CheckpointStore, checkpointStoreSchema } from "./types.js"

const empty: CheckpointStore = { checkpoints: {} }

export const readCheckpoints = async (fs: FileSystem, path: string): Promise<CheckpointStore> => {
  try {
    const parsed = checkpointStoreSchema.safeParse(JSON.parse(await fs.readFile(path)))
    return parsed.success ? parsed.data : empty
  } catch {
    return empty
  }
}

export const writeCheckpoints = async (
  fs: FileSystem,
  path: string,
  store: CheckpointStore,
): Promise<void> => {
  const tmp = `${path}.tmp`
  await fs.writeFile(tmp, JSON.stringify(store, null, 2))
  await fs.rename(tmp, path)
}
