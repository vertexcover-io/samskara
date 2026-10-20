import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

/** A scratch folder for one agent run: `files` written into it, `work` run, the folder removed. */
export const withWorkspace = async <T>(
  /** Names the folder, e.g. `samskara-review-reader-`, so a run's transcript can be found. */
  prefix: string,
  files: Readonly<Record<string, string>>,
  work: (dir: string) => Promise<T>,
): Promise<T> => {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  try {
    for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text)
    return await work(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** A file's text, or `fallback` (empty by default) when it cannot be read. */
export const readOr = <F = string>(path: string, fallback: F = "" as F): Promise<string | F> =>
  readFile(path, "utf8").catch(() => fallback)
