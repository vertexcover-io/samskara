import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import * as lockfile from "proper-lockfile"

const LOCK_RETRY_MS = 20
const LOCK_TIMEOUT_MS = 5_000

export type LockOptions = {
  readonly timeoutMs?: number
}

export const readJson = async (path: string): Promise<unknown> => {
  try {
    return JSON.parse(await readFile(path, "utf8"))
  } catch {
    return undefined
  }
}

export const atomicWriteJson = async (path: string, value: unknown): Promise<void> => {
  await mkdir(dirname(path), { recursive: true })
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flush: true })
  await rename(tempPath, path)
}

export const withFileLock = async <T>(
  path: string,
  action: () => Promise<T>,
  options: LockOptions = {},
): Promise<T> => {
  await mkdir(dirname(path), { recursive: true })
  const timeoutMs = options.timeoutMs ?? LOCK_TIMEOUT_MS
  let release: (() => Promise<void>) | undefined
  try {
    release = await lockfile.lock(path, {
      realpath: false,
      stale: 30_000,
      update: 10_000,
      retries: {
        retries: Math.ceil(timeoutMs / LOCK_RETRY_MS),
        minTimeout: LOCK_RETRY_MS,
        maxTimeout: LOCK_RETRY_MS,
        randomize: false,
      },
    })
  } catch {
    throw new Error(`timed out acquiring lock: ${path}.lock`)
  }

  try {
    return await action()
  } finally {
    await release()
  }
}
