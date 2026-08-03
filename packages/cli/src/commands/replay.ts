import { basename, sep } from "node:path"
import { checkpointStoreSchema } from "@samskara/core"
import { atomicWriteJson, readJson, withFileLock } from "../config/atomic.js"

interface Writer {
  write(text: string): unknown
}

export type ReplayDeps = {
  readonly apiBase: string
  readonly token: string | null
  readonly fetch: typeof globalThis.fetch
  readonly paths: {
    readonly state: string
    readonly artifacts: string
    readonly queue: string
  }
  /** Answers whether it stopped anything, so the replay knows whether to bring it back. */
  readonly stopWatcher: () => Promise<boolean>
  readonly startWatcher: () => Promise<unknown>
  readonly stdout?: Writer
}

/**
 * A session owns two kinds of transcript: `<id>.jsonl` beside its siblings, and the subagent
 * sidecars under a directory named for it. Checkpoints are keyed by file path, so both shapes have
 * to match or the branches never re-ingest and the replay looks like it dropped them.
 */
export const belongsToSession = (filePath: string, sessionId: string): boolean =>
  basename(filePath) === `${sessionId}.jsonl` || filePath.includes(`${sep}${sessionId}${sep}`)

const clearCheckpoints = async (path: string, sessionId: string): Promise<number> =>
  withFileLock(path, async () => {
    const parsed = checkpointStoreSchema.safeParse(await readJson(path))
    if (!parsed.success) return 0

    const kept = Object.entries(parsed.data.checkpoints).filter(
      ([, checkpoint]) => !belongsToSession(checkpoint.filePath, sessionId),
    )
    const dropped = Object.keys(parsed.data.checkpoints).length - kept.length
    if (dropped > 0) await atomicWriteJson(path, { checkpoints: Object.fromEntries(kept) })
    return dropped
  })

/** Artifact state is keyed `<sessionId>:<path>`, and a session id is a UUID, so it holds no colon. */
const clearArtifactState = async (path: string, sessionId: string): Promise<number> =>
  withFileLock(path, async () => {
    const state = await readJson(path)
    const artifacts = (state as { artifacts?: Record<string, unknown> } | null)?.artifacts
    if (!artifacts) return 0

    const kept = Object.entries(artifacts).filter(([key]) => !key.startsWith(`${sessionId}:`))
    const dropped = Object.keys(artifacts).length - kept.length
    if (dropped > 0)
      await atomicWriteJson(path, { version: 1, artifacts: Object.fromEntries(kept) })
    return dropped
  })

const clearQueue = async (path: string, sessionId: string): Promise<number> =>
  withFileLock(path, async () => {
    const queue = await readJson(path)
    const entries = (queue as { entries?: ReadonlyArray<{ sessionId?: string }> } | null)?.entries
    if (!Array.isArray(entries)) return 0

    const kept = entries.filter((entry) => entry.sessionId !== sessionId)
    const dropped = entries.length - kept.length
    if (dropped > 0) await atomicWriteJson(path, { version: 1, entries: kept })
    return dropped
  })

const deleteRemote = async (deps: ReplayDeps, sessionId: string): Promise<string | null> => {
  const res = await deps
    .fetch(`${deps.apiBase}/api/sessions/${sessionId}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${deps.token}` },
    })
    .catch((error: unknown) => {
      return { ok: false, status: 0, error } as const
    })

  // A session the server never had is already in the state a replay wants, so 404 is success.
  if ("ok" in res && res.status === 0) return `could not reach ${deps.apiBase}`
  if (res.status === 204 || res.status === 404) return null
  return `server refused the delete with ${res.status}`
}

/**
 * Puts a session back to never-captured: the server row and every local trace of having sent it.
 * The watcher is stopped for the whole operation because it holds the same three files under lock
 * and would otherwise re-checkpoint mid-clear, and restarted afterwards only if it was running to
 * begin with.
 */
export const replayCommand = async (sessionId: string, deps: ReplayDeps): Promise<number> => {
  const stdout = deps.stdout ?? process.stdout

  if (!deps.token) {
    stdout.write("Not logged in. Run `samskara login` first.\n")
    return 1
  }

  const wasRunning = await deps.stopWatcher()

  try {
    const failure = await deleteRemote(deps, sessionId)
    // Local state is left alone on failure: clearing it while the server still holds the old rows
    // is the half-state the replay exists to avoid, because re-ingest upserts and never deletes.
    if (failure !== null) {
      stdout.write(`Replay aborted -- ${failure}. Nothing local was changed.\n`)
      return 1
    }

    const checkpoints = await clearCheckpoints(deps.paths.state, sessionId)
    const artifacts = await clearArtifactState(deps.paths.artifacts, sessionId)
    const queued = await clearQueue(deps.paths.queue, sessionId)

    stdout.write(
      `Replaying ${sessionId}: removed server-side, cleared ${checkpoints} checkpoint(s), ` +
        `${artifacts} artifact hash(es), ${queued} queued upload(s).\n`,
    )
    return 0
  } finally {
    if (wasRunning) {
      await deps.startWatcher()
      stdout.write("Watcher restarted; it will re-ingest the transcript on its next cycle.\n")
    }
  }
}
