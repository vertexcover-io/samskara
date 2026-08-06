import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import type pino from "pino"
import * as lockfile from "proper-lockfile"
import type { z } from "zod"

const LOCK_RETRY_MS = 20
const LOCK_TIMEOUT_MS = 5_000
const LOGGED_CONTENT_LIMIT = 2_000

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

/**
 * Null for a file that is absent, which is every first run. Anything present that will not parse
 * throws, carrying the content it could not read so a caller can report it without a second read.
 */
export const readValidated = async <S extends z.ZodTypeAny>(
  path: string,
  schema: S,
): Promise<z.output<S> | null> => {
  const text = await readFile(path, "utf8").catch(() => null)
  if (text === null) return null

  try {
    return schema.parse(JSON.parse(text)) as z.output<S>
  } catch (cause) {
    throw Object.assign(new Error(`${path} did not parse`, { cause }), { content: text })
  }
}

/**
 * Resets the file so the next read succeeds, which is what stops one corrupt file erroring on every
 * read for the rest of the process. The content is logged first because the reset is what destroys
 * it. Callers holding this file's lock must already hold it: this writes without taking one.
 */
export const readOrReset = async <S extends z.ZodTypeAny>(
  path: string,
  schema: S,
  empty: () => z.output<S>,
  message: string,
  log?: pino.Logger,
): Promise<z.output<S>> => {
  try {
    return (await readValidated(path, schema)) ?? empty()
  } catch (error) {
    const { content } = error as { content?: string }
    log?.error({ path, err: error, content: content?.slice(0, LOGGED_CONTENT_LIMIT) }, message)
    await atomicWriteJson(path, empty())
    return empty()
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
