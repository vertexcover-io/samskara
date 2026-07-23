import type { FileSystem } from "./fs.js"
import { type WatcherState, watcherStateSchema } from "./types.js"

const empty: WatcherState = { files: {} }

export const readState = async (fs: FileSystem, path: string): Promise<WatcherState> => {
  try {
    const parsed = watcherStateSchema.safeParse(JSON.parse(await fs.readFile(path)))
    return parsed.success ? parsed.data : empty
  } catch {
    return empty
  }
}

export const writeState = async (
  fs: FileSystem,
  path: string,
  state: WatcherState,
): Promise<void> => {
  const tmp = `${path}.tmp`
  await fs.writeFile(tmp, JSON.stringify(state, null, 2))
  await fs.rename(tmp, path)
}
