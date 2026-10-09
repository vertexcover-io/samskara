import { open, readdir, realpath, stat } from "node:fs/promises"
import { join } from "node:path"
import {
  COMPOUND_LEARNINGS_BATCH_MAX,
  type CompoundLearningEvent,
  compoundLearningEventSchema,
} from "@samskara/core"
import type pino from "pino"
import { z } from "zod"
import { atomicWriteJson, readOrReset } from "../config/atomic.js"
import type { RegisteredProject } from "../config/projects.js"
import { runGitOrNull } from "../git.js"
import { errorMessage } from "../io.js"
import type { SinkResult } from "./sink.js"

/**
 * Uploads what the `/learn` skill (harness or yok plugin) appends to
 * `.harness/learning-events/` or `.yok/learning-events/` at the top of a repo. Only the folders of
 * samskara-enabled projects, and their git worktrees, are read, so consent is decided by where a
 * file is rather than by what it says. Each file has a checkpoint: a raw byte offset that only moves
 * past whole lines (ending in `\n`). The server skips eventIds it already holds, so re-sending
 * after a failure is harmless.
 */

/** Where the skill writes, relative to the repo's top level. */
const LEARNING_EVENT_DIRS = [
  join(".harness", "learning-events"),
  join(".yok", "learning-events"),
] as const

const BACKOFF_BASE_MS = 30_000
const BACKOFF_CAP_MS = 60 * 60 * 1000

export const backoffMs = (failures: number): number =>
  Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1), BACKOFF_CAP_MS)

// ---------------------------------------------------------------------------------------------
// Parsing

// Not UTF-8 or not JSON is broken for good and skipped. JSON this CLI's contract rejects may be an
// event from a newer skill (a new outcome, say), so it is held for a CLI that knows it.
type ParsedLearningEventLine =
  | { readonly kind: "event"; readonly event: CompoundLearningEvent }
  | { readonly kind: "broken"; readonly reason: string }
  | { readonly kind: "unknown"; readonly reason: string }

const utf8 = new TextDecoder("utf-8", { fatal: true })

const parseLearningEventLine = (bytes: Uint8Array): ParsedLearningEventLine => {
  let text: string
  try {
    text = utf8.decode(bytes)
  } catch {
    return { kind: "broken", reason: "not valid UTF-8" }
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    return { kind: "broken", reason: `not JSON (${errorMessage(error)})` }
  }
  const parsed = compoundLearningEventSchema.safeParse(value)
  if (parsed.success) return { kind: "event", event: parsed.data }
  const reason = parsed.error.issues
    .map(
      (issue) => `${issue.path.length === 0 ? "(event)" : issue.path.join(".")}: ${issue.message}`,
    )
    .join("; ")
  return { kind: "unknown", reason }
}

// ---------------------------------------------------------------------------------------------
// Sources

/** One folder of events, and the cutoff of the project it belongs to. */
export type EventSource = { readonly dir: string; readonly syncFrom?: string }

/** git prints real paths, so a registered path reached through a symlink is resolved to match. */
const canonical = (path: string): Promise<string> => realpath(path).catch(() => path)

/** Every checkout of the repo at `path`: the folder itself, then its worktrees. */
export const worktreeFolders = async (path: string): Promise<ReadonlyArray<string>> => {
  const out = await runGitOrNull(["worktree", "list", "--porcelain"], path)
  const listed = (out ?? "")
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length))
  return [...new Set([await canonical(path), ...listed])]
}

/**
 * The event folders of every enabled project's checkouts. A checkout registered on its own and
 * disabled is left out even when it is a worktree of an enabled one.
 */
export const listEventSources = async (
  projects: ReadonlyArray<RegisteredProject>,
  foldersOf: (path: string) => Promise<ReadonlyArray<string>>,
): Promise<ReadonlyArray<EventSource>> => {
  const disabled = new Set(
    await Promise.all(
      projects.filter(({ entry }) => !entry.enabled).map(({ entry }) => canonical(entry.path)),
    ),
  )
  const perProject = await Promise.all(
    projects
      .filter(({ entry }) => entry.enabled)
      .map(async ({ entry }) =>
        (await foldersOf(entry.path))
          .filter((folder) => !disabled.has(folder))
          .flatMap((folder) =>
            LEARNING_EVENT_DIRS.map((dir) => ({
              dir: join(folder, dir),
              ...(entry.syncFrom === undefined ? {} : { syncFrom: entry.syncFrom }),
            })),
          ),
      ),
  )
  // Two projects can share a checkout; the stricter (later) cutoff wins.
  const byDir = new Map<string, EventSource>()
  for (const source of perProject.flat()) {
    const seen = byDir.get(source.dir)
    if (seen === undefined || (source.syncFrom ?? "") > (seen.syncFrom ?? ""))
      byDir.set(source.dir, source)
  }
  return [...byDir.values()]
}

/** Events from before the project's sync-from cutoff stay local, like its transcripts. */
export const isBeforeCutoff = (event: CompoundLearningEvent, syncFrom?: string): boolean =>
  syncFrom !== undefined && Date.parse(event.timestamp) < Date.parse(syncFrom)

// ---------------------------------------------------------------------------------------------
// Files and state

const listLearningEventFiles = async (dir: string): Promise<ReadonlyArray<string> | null> => {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map((entry) => join(dir, entry.name))
      .sort()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
}

/** Raw bytes `[start, end)`: offsets stay byte counts, whatever the text decodes to. */
const readFileRange = async (path: string, start: number, end: number): Promise<Buffer> => {
  const handle = await open(path, "r")
  try {
    const buffer = Buffer.alloc(end - start)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

const fileStateSchema = z.object({
  offset: z.number().int().nonnegative(),
  failures: z.number().int().positive().optional(),
  nextAttemptAt: z.number().optional(),
})

const stateSchema = z.object({
  version: z.literal(1),
  apiBase: z.string().optional(),
  files: z.record(z.string(), fileStateSchema),
})

type FileState = z.infer<typeof fileStateSchema>
type State = z.infer<typeof stateSchema>

// ---------------------------------------------------------------------------------------------
// The step

type LearningEventsConfig = {
  readonly statePath: string
}

export type LearningEventsDeps = {
  readonly listFiles: (dir: string) => Promise<ReadonlyArray<string> | null>
  readonly size: (path: string) => Promise<number>
  readonly readRange: (path: string, start: number, end: number) => Promise<Uint8Array>
  readonly listSources: () => Promise<ReadonlyArray<EventSource>>
  readonly hasToken: () => Promise<boolean>
  readonly send: (events: ReadonlyArray<CompoundLearningEvent>) => Promise<SinkResult>
  /** Stamped into the state file like every other server-scoped file, so `init --force` resets it. */
  readonly apiBase: string
  readonly now: () => number
  readonly log: pino.Logger
}

type Pending = { readonly event: CompoundLearningEvent; readonly start: number }

type FileOutcome = { readonly state: FileState; readonly unauthorized: boolean }

const NEWLINE = 0x0a

const isOk = (status: number): boolean => status >= 200 && status < 300

const processFile = async (
  deps: LearningEventsDeps,
  file: string,
  current: FileState,
  syncFrom: string | undefined,
): Promise<FileOutcome> => {
  const unchanged = { state: current, unauthorized: false }
  const size = await deps.size(file)
  const shrank = size < current.offset
  if (shrank) deps.log.info({ file }, "Learning events file shrank; reading it from the start")
  const from = shrank ? 0 : current.offset
  if (size === from) return shrank ? { state: { offset: 0 }, unauthorized: false } : unchanged

  const bytes = await deps.readRange(file, from, size)
  const pending: Pending[] = []
  let settled = from
  let start = 0
  for (let end = bytes.indexOf(NEWLINE); end !== -1; end = bytes.indexOf(NEWLINE, start)) {
    const lineStart = from + start
    const raw = bytes.subarray(start, end)
    start = end + 1
    const lineEnd = from + start
    if (raw.every((byte) => byte === 0x20 || byte === 0x09 || byte === 0x0d)) {
      settled = lineEnd
      continue
    }
    const parsed = parseLearningEventLine(raw)
    if (parsed.kind === "broken") {
      deps.log.warn(
        { file, byteOffset: lineStart, reason: parsed.reason },
        "Skipping malformed learning event",
      )
      settled = lineEnd
      continue
    }
    if (parsed.kind === "unknown") {
      deps.log.warn(
        { file, byteOffset: lineStart, reason: parsed.reason },
        "Learning event this CLI does not understand; holding the file here until an upgrade",
      )
      break
    }
    const { event } = parsed
    if (isBeforeCutoff(event, syncFrom))
      deps.log.debug(
        { file, eventId: event.event_id },
        "Learning event before the project's cutoff; not uploaded",
      )
    else pending.push({ event, start: lineStart })
    settled = lineEnd
  }

  for (let index = 0; index < pending.length; index += COMPOUND_LEARNINGS_BATCH_MAX) {
    const batch = pending.slice(index, index + COMPOUND_LEARNINGS_BATCH_MAX)
    const result = await deps.send(batch.map((item) => item.event))
    if (isOk(result.status)) continue
    const keepAt = batch.at(0)?.start ?? from
    if (result.status === 401) {
      deps.log.warn({ file, detail: result.detail }, "Learning events upload unauthorized; pausing")
      return { state: { offset: keepAt }, unauthorized: true }
    }
    const failures = (current.failures ?? 0) + 1
    const nextAttemptAt = deps.now() + backoffMs(failures)
    deps.log.warn(
      {
        file,
        status: result.status,
        detail: result.detail,
        reqId: result.reqId,
        failures,
        nextAttemptAt,
      },
      "Learning events upload failed; will retry",
    )
    return { state: { offset: keepAt, failures, nextAttemptAt }, unauthorized: false }
  }
  if (pending.length > 0) deps.log.info({ file, count: pending.length }, "Learning events uploaded")
  return settled === current.offset && current.failures === undefined
    ? unchanged
    : { state: { offset: settled }, unauthorized: false }
}

const sameState = (a: State, b: State): boolean => JSON.stringify(a) === JSON.stringify(b)

export const runLearningEventsStep = async (
  config: LearningEventsConfig,
  deps: LearningEventsDeps,
): Promise<void> => {
  if (!(await deps.hasToken())) return
  const sources = await deps.listSources()
  const listed = await Promise.all(
    sources.map(async ({ dir, syncFrom }) =>
      ((await deps.listFiles(dir)) ?? []).map((file) => ({ file, syncFrom })),
    ),
  )
  const found = listed.flat()

  const before: State = await readOrReset(
    config.statePath,
    stateSchema,
    (): State => ({ version: 1, files: {} }),
    "Learning events state unreadable; starting over (the server skips what it already has)",
    deps.log,
  )
  if (found.length === 0 && Object.keys(before.files).length === 0) return

  // Files no longer listed are dropped. A file skipped (backing off, or not reached after a 401)
  // keeps its old state.
  const next = new Map<string, FileState>()
  let unauthorized = false
  for (const { file, syncFrom } of found) {
    const kept = before.files[file]
    const backingOff = kept?.nextAttemptAt !== undefined && kept.nextAttemptAt > deps.now()
    if (unauthorized || backingOff) {
      if (kept !== undefined) next.set(file, kept)
      continue
    }
    const current = kept ?? { offset: 0 }
    const outcome = await processFile(deps, file, current, syncFrom).catch((err: unknown) => {
      deps.log.warn({ file, err }, "Learning events file unreadable; will retry")
      return { state: current, unauthorized: false }
    })
    next.set(file, outcome.state)
    unauthorized = outcome.unauthorized
  }

  const after: State = { version: 1, apiBase: deps.apiBase, files: Object.fromEntries(next) }
  if (!sameState(before, after)) await atomicWriteJson(config.statePath, after)
}

/** The production wiring, kept here so it is testable without starting the watcher. */
export const nodeLearningEventsDeps = (
  base: Pick<LearningEventsDeps, "listSources" | "hasToken" | "send" | "apiBase" | "log">,
): LearningEventsDeps => ({
  ...base,
  listFiles: listLearningEventFiles,
  size: async (path) => (await stat(path)).size,
  readRange: readFileRange,
  now: () => Date.now(),
})

/**
 * Runs the step off the watch loop, the way the artifact workers run: the loop calls `tick()` every
 * cycle and never waits on it, so a slow or failing upload cannot delay or break transcript
 * ingest. A tick while the previous run is still going does nothing.
 */
export const startLearningEventsTicker = (
  step: () => Promise<void>,
  log: pino.Logger,
): (() => void) => {
  let running = false
  return () => {
    if (running) return
    running = true
    void step()
      .catch((err: unknown) => {
        log.error({ err }, "Learning events step failed")
      })
      .finally(() => {
        running = false
      })
  }
}
