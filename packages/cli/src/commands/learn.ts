import { resolve } from "node:path"
import { z } from "zod"
import { readToken as defaultReadToken } from "../config/credentials.js"
import { apiBase as defaultApiBase } from "../config.js"
import {
  sleep as defaultSleep,
  reportError,
  resolveIo,
  serverUnreachable,
  type Writer,
} from "../io.js"

const runSchema = z.object({
  run: z.object({ id: z.string(), status: z.string(), error: z.string().nullable() }).loose(),
})
const listSchema = z.object({
  learnings: z.array(
    z
      .object({
        title: z.string(),
        priority: z.string(),
        priorityReason: z.string(),
        problem: z.string(),
        fixType: z.string(),
        fix: z.string(),
        problemCount: z.number(),
        sessionCount: z.number(),
        // Optional so this CLI still reads a server from before Skip.
        skippedAt: z.string().nullable().optional(),
      })
      .loose(),
  ),
})

export type LearnOptions = {
  /** The project's id. */
  readonly project: string
  /** A checkout of the harness on the server's machine; the server's own setting otherwise. */
  readonly harnessPath?: string
  readonly stdout?: Writer
  readonly stderr?: Writer
  readonly apiBase?: string
  readonly readToken?: () => Promise<string | null>
  readonly fetch?: typeof globalThis.fetch
  readonly sleep?: (ms: number) => Promise<void>
  /** How long to wait for the run before giving up; `MAX_WAIT_MS` when absent. */
  readonly maxWaitMs?: number
}

/** A run is two agents per batch of problems, so minutes, not seconds. */
const POLL_MS = 5_000

/**
 * A long first run is up to 40 batches; past this the run is likely stuck (a server that could
 * not mark it finished keeps it `running`), so stop waiting rather than poll forever.
 */
export const MAX_WAIT_MS = 3 * 60 * 60 * 1000

const startedSchema = z.object({ runId: z.string() })

const ERRORS: Record<string, string> = {
  projectNotFound: "No such project, or this account cannot see it.",
  notEditable: "Only an editor of the project can start a learning run.",
  harnessPathNeedsAdmin: "Only a project admin can pass --harness-path.",
  noHarnessPath:
    "No harness to check against: pass --harness-path, or set LEARNINGS_HARNESS_REPO (or LEARNINGS_HARNESS_PATH) on the server.",
  learningRunAlreadyRunning:
    "A learning run is already going for this project. Wait for it to finish.",
}

/**
 * `samskara learn`: starts a learning run for the project, waits for it, and prints the
 * project's learnings, high priority first. The run itself happens on the server.
 */
export const learnCommand = async (options: LearnOptions): Promise<number> => {
  const { stdout, stderr } = resolveIo(options)
  const fetch = options.fetch ?? globalThis.fetch
  const sleep = options.sleep ?? defaultSleep
  const apiBase = options.apiBase ?? defaultApiBase()
  try {
    const token = await (options.readToken ?? defaultReadToken)()
    if (token === null) throw new Error("Not logged in. Run `samskara login` first.")
    const call = async (path: string, init: RequestInit = {}) => {
      let res: Response
      try {
        res = await fetch(`${apiBase}${path}`, {
          ...init,
          headers: { ...init.headers, authorization: `Bearer ${token}` },
        })
      } catch (error) {
        throw serverUnreachable(apiBase, error)
      }
      const body: unknown = await res.json().catch(() => null)
      if (res.ok) return body
      if (res.status === 401)
        throw new Error("The server rejected the stored login. Run `samskara login` again.")
      const code = (body as { error?: string } | null)?.error ?? ""
      throw new Error(
        ERRORS[code] ?? `The server answered ${res.status}${code === "" ? "" : ` (${code})`}.`,
      )
    }

    const started = startedSchema.parse(
      await call("/api/learnings/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          project: options.project,
          // The server resolves a relative path against its own folder, not this one.
          ...(options.harnessPath === undefined
            ? {}
            : { harnessPath: resolve(options.harnessPath) }),
        }),
      }),
    )
    stderr.write(`Learning run ${started.runId} started. Waiting for it to finish…\n`)

    const maxWaitMs = options.maxWaitMs ?? MAX_WAIT_MS
    for (let waited = 0; ; waited += POLL_MS) {
      const { run } = runSchema.parse(await call(`/api/learnings/runs/${started.runId}`))
      if (run.status === "failed")
        throw new Error(`The learning run failed: ${run.error ?? "no reason given"}`)
      if (run.status === "done") break
      if (waited >= maxWaitMs)
        throw new Error(
          `Stopped waiting for learning run ${started.runId}: still running after ${Math.round(maxWaitMs / 60_000)} minutes.`,
        )
      await sleep(POLL_MS)
    }

    const learnings = listSchema
      .parse(await call(`/api/learnings?project=${encodeURIComponent(options.project)}`))
      .learnings.filter((learning) => (learning.skippedAt ?? null) === null)
    if (learnings.length === 0) {
      stdout.write("No learnings yet.\n")
      return 0
    }
    for (const [index, learning] of learnings.entries()) {
      stdout.write(
        [
          `${index + 1}. [${learning.priority}] ${learning.title}`,
          `   ${learning.problemCount} problems in ${learning.sessionCount} sessions. ${learning.priorityReason}`,
          `   Problem: ${learning.problem}`,
          `   Fix (${learning.fixType}): ${learning.fix}`,
          "",
        ].join("\n"),
      )
    }
    return 0
  } catch (error) {
    return reportError(stderr, error)
  }
}
