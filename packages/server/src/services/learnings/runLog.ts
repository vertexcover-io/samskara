import { createReadStream, createWriteStream } from "node:fs"
import { appendFile, mkdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { pipeline } from "node:stream/promises"
import { createGzip } from "node:zlib"
import type pino from "pino"

/**
 * Where each run's log goes: `.samskara/learning-runs/<runId>.jsonl.gz` under the server's
 * working directory. Gitignored, since it holds problem text, which can quote a secret.
 */
export const LEARNING_RUNS_DIR = join(".samskara", "learning-runs")

export type RunLog = {
  /** Adds one line: `{ ts, runId, step, ...fields }`. Writes are queued, never awaited. */
  readonly event: (step: string, fields?: Readonly<Record<string, unknown>>) => void
  /** Waits for every queued line, then compresses the file and removes the plain copy. */
  readonly close: () => Promise<void>
  /** The finished file; null when the log could not be written. */
  readonly path: string | null
}

/**
 * A run's log: one JSON line per step of how it decided — which problems went into which
 * group, each verdict and drop reason, each priority, what was saved — so the run can be
 * checked after the agents' own files are gone. Lines go to a plain `.jsonl` while the run is
 * going, so a run the server never finishes still leaves a readable file; `close` gzips it. A
 * log that cannot be written is a warning, never a failed run.
 */
export const openRunLog = async (dir: string, runId: string, log: pino.Logger): Promise<RunLog> => {
  const plain = join(dir, `${runId}.jsonl`)
  const gz = `${plain}.gz`
  try {
    await mkdir(dir, { recursive: true })
  } catch (error) {
    log.warn({ err: error, dir }, "learning run log could not be created")
    return { event: () => {}, close: async () => {}, path: null }
  }
  let pending: Promise<void> = Promise.resolve()
  let failed = false
  const warn = (error: unknown): void => {
    if (!failed) log.warn({ err: error, path: plain }, "learning run log write failed")
    failed = true
  }
  return {
    path: gz,
    event: (step, fields = {}) => {
      const line = `${JSON.stringify({ ts: new Date().toISOString(), runId, step, ...fields })}\n`
      pending = pending.then(() => appendFile(plain, line).catch(warn))
    },
    close: async () => {
      await pending
      if (failed) return
      try {
        await pipeline(createReadStream(plain), createGzip(), createWriteStream(gz))
        await rm(plain)
      } catch (error) {
        warn(error)
      }
    },
  }
}
