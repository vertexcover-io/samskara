import type { AiReviewLens } from "@samskara/core"
import { readToken } from "../config/credentials.js"
import { apiBase, webBase } from "../config.js"
import { errorMessage, resolveIo, sleep, type Writer } from "../io.js"

export type ReviewDeps = {
  readonly apiBase: string
  readonly token: string | null
  readonly fetch: typeof globalThis.fetch
  readonly now?: () => Date
  readonly stdout?: Writer
  readonly stderr?: Writer
  readonly sleep?: (ms: number) => Promise<void>
}

export type ReviewResponse = {
  readonly reviewId: string
  readonly review: {
    readonly sessionId: string
    readonly analyzer: string
    readonly analyzedAt: string
    readonly outcome: string
    readonly friction: string
    readonly summary: string
    readonly signals: {
      readonly turns: number
      readonly toolCalls: number
      readonly toolFailures: number
      readonly errorLoops: ReadonlyArray<{ toolName: string; consecutiveFailures: number }>
    }
    readonly agentLearnings: ReadonlyArray<{ title: string }>
    readonly humanFeedback: ReadonlyArray<{ title: string; detail: string }>
  }
}

const OUTCOME_LINES: Record<string, string> = {
  shipped: "shipped — work landed (commit or PR)",
  productive: "productive — exploration without landing evidence",
  struggled: "struggled — high friction and nothing landed",
  aborted: "aborted — the last turn was stopped with nothing committed",
}

/**
 * Reviews one session server-side and prints what came back: the verdict line, the human
 * feedback (the part a person reads first), and the agent learnings by title. The full
 * detail lives on the server; this stays a reading, not a dump.
 */
export const reviewOne = async (
  sessionId: string,
  deps: ReviewDeps,
): Promise<{ ok: boolean; message?: string }> => {
  const { stdout } = resolveIo({ stdout: deps.stdout })
  if (deps.token === null) return { ok: false, message: "Not paired -- run `samskara login`." }
  const res = await deps.fetch(`${deps.apiBase}/api/sessions/${sessionId}/review`, {
    method: "POST",
    headers: { authorization: `Bearer ${deps.token}` },
  })
  if (res.status === 404) return { ok: false, message: `No session ${sessionId} on this server.` }
  if (!res.ok) return { ok: false, message: `The server refused the review (${res.status}).` }
  const body = (await res.json()) as ReviewResponse
  const review = body.review

  stdout.write(`Session ${review.sessionId}\n`)
  stdout.write(`  ${review.summary}\n`)
  stdout.write(`  ${OUTCOME_LINES[review.outcome] ?? review.outcome}\n`)
  stdout.write(`  ${webBase()}/sessions/${review.sessionId}\n`)

  if (review.humanFeedback.length > 0) {
    stdout.write("\nWhat you could have done better\n")
    for (const item of review.humanFeedback) {
      stdout.write(`  - ${item.title}\n    ${item.detail}\n`)
    }
  }
  if (review.agentLearnings.length > 0) {
    stdout.write("\nLearnings for agents (candidate until accepted)\n")
    for (const item of review.agentLearnings) stdout.write(`  - ${item.title}\n`)
  }
  return { ok: true }
}

type RecentIds = { readonly ids: ReadonlyArray<string> } | { readonly error: string }

const listRecent = async (limit: number, deps: ReviewDeps): Promise<RecentIds> => {
  const res = await deps
    .fetch(`${deps.apiBase}/api/sessions?sort=recent&limit=${limit}`, {
      headers: { authorization: `Bearer ${deps.token}` },
    })
    .catch(() => null)
  if (res === null) return { error: `Could not reach ${deps.apiBase}.` }
  if (!res.ok) return { error: `The server refused the session list (${res.status}).` }
  const body = (await res.json()) as { sessions: ReadonlyArray<{ id: string }> }
  return { ids: body.sessions.map((session) => session.id) }
}

export type AiReviewResponse = {
  /** Null while the session's analysis job is still running — the poll keeps waiting then. */
  readonly review: {
    readonly id: string
    readonly createdAt: string
    readonly outcome: string
    readonly friction: string
    readonly summary: string
    readonly signals: {
      readonly model: string
      readonly harness: string
      readonly lenses: ReadonlyArray<AiReviewLens>
    }
  } | null
  /** Present only while a job for the session is in flight (the attach path reads it). */
  readonly job?: {
    readonly jobId: string
    readonly status: string
    readonly startedAt: string
    readonly lastEvent: { readonly name: string; readonly at: string } | null
  }
}

/** The verdict once it has landed — the non-null half of AiReviewResponse["review"]. */
type ArrivedAiReview = NonNullable<AiReviewResponse["review"]>

/** How often the poll loop re-reads GET /:id/aireview while waiting for the job to land. */
const AI_POLL_INTERVAL_MS = 3_000
const AI_TIMEOUT_MS = 600_000
/**
 * Progress is printed at most this often — quieter than every poll, still visible to a
 * watching human. Also re-reads GET /:id/analyze/:jobId so the line can name the latest
 * pipeline milestone the server has reported.
 */
const AI_PROGRESS_INTERVAL_MS = 15_000

const formatLastEvent = (
  lastEvent: { name: string; at: string } | null,
  startedAt: number,
  now: number,
): string => {
  if (lastEvent === null) return "no event yet"
  const seconds = Math.max(0, Math.round((now - new Date(lastEvent.at).getTime()) / 1000))
  const total = Math.round((now - startedAt) / 1000)
  return `${lastEvent.name} (${seconds}s ago, ${total}s total)`
}

/** The strict --json gate: a verdict without lenses is not a verdict an agent can act on. */
const aiReviewHasLenses = (review: ArrivedAiReview): boolean =>
  typeof review.outcome === "string" &&
  review.outcome !== "" &&
  typeof review.friction === "string" &&
  Array.isArray(review.signals?.lenses) &&
  review.signals.lenses.length > 0

const printAiReview = (
  sessionId: string,
  review: ArrivedAiReview,
  io: { stdout: Writer; stderr: Writer; json: boolean },
): void => {
  if (io.json) {
    io.stdout.write(`${JSON.stringify(review, null, 2)}\n`)
    return
  }
  const { stdout } = io
  const { model, harness, lenses } = review.signals
  stdout.write(`Session ${sessionId} -- AI review (${model} via ${harness})\n`)
  stdout.write(`  ${OUTCOME_LINES[review.outcome] ?? review.outcome}\n`)
  stdout.write(`  friction: ${review.friction}\n`)
  stdout.write(`  ${review.summary}\n`)
  for (const lens of lenses) {
    if (lens.lens !== "timeline") continue
    stdout.write("\nTimeline\n")
    for (const entry of lens.entries) {
      stdout.write(
        `  [${entry.kind}] ${entry.title} (seq ${entry.fromSeq}-${entry.toSeq}, ${entry.messageIds.length} messages)\n`,
      )
    }
  }
  const learnings = lenses
    .filter((lens) => lens.lens !== "timeline")
    .flatMap((lens) => {
      const who = lens.lens === "humanLearnings" ? "HUMANS" : "AGENTS"
      return lens.learnings.map(
        (learning) =>
          `  FOR ${who} [${learning.category}] ${learning.title} — ${learning.detail}\n`,
      )
    })
  if (learnings.length > 0) {
    stdout.write("\nLearnings\n")
    for (const line of learnings) stdout.write(line)
  }
}

/**
 * One AI review: start the server-side analysis, then poll GET /:id/aireview until the ai-v1
 * row lands (404 noAiReview just means the job is still running). The verdict prints the
 * outcome, friction, the model/harness that produced it and the lens renderings; `--json`
 * prints the raw review instead, and refuses (exit 1) when the lenses array is empty.
 */
export const reviewAiOne = async (
  sessionId: string,
  deps: ReviewDeps,
  options: { readonly json?: boolean; readonly timeoutMs?: number } = {},
): Promise<{ ok: boolean; message?: string }> => {
  const { stdout, stderr } = resolveIo({ stdout: deps.stdout, stderr: deps.stderr })
  const now = deps.now ?? (() => new Date())
  const pause = deps.sleep ?? sleep
  const timeoutMs = options.timeoutMs ?? AI_TIMEOUT_MS

  /** Prints an arrived verdict under the same --json lenses gate the poll path uses. */
  const finishWith = (body: AiReviewResponse): { ok: boolean; message?: string } | null => {
    if (body.review === null) return null
    if (options.json === true && !aiReviewHasLenses(body.review)) {
      stderr.write("The AI review arrived without lenses; nothing to print.\n")
      return { ok: false }
    }
    printAiReview(sessionId, body.review, { stdout, stderr, json: options.json === true })
    return { ok: true }
  }

  const readAiReview = async (): Promise<AiReviewResponse | null> => {
    const res = await deps
      .fetch(`${deps.apiBase}/api/sessions/${sessionId}/aireview`, {
        headers: { authorization: `Bearer ${deps.token}` },
      })
      .catch(() => null)
    if (res === null || !res.ok) return null
    return (await res.json()) as AiReviewResponse
  }

  const started = await deps
    .fetch(`${deps.apiBase}/api/sessions/${sessionId}/analyze`, {
      method: "POST",
      headers: { authorization: `Bearer ${deps.token}` },
    })
    .catch(() => null)
  if (started === null) return { ok: false, message: `Could not reach ${deps.apiBase}.` }
  if (started.status === 404)
    return { ok: false, message: `No session ${sessionId} on this server.` }
  if (started.status === 403)
    return {
      ok: false,
      message: "Analysis refused (403): you can edit this project to analyze it.",
    }
  if (started.status === 503)
    return { ok: false, message: "The server is running 4 analyses already; retry shortly." }

  let jobId = ""
  let startedAt = now().getTime()
  let lastEvent: { name: string; at: string } | null = null

  if (started.status === 409) {
    const conflict = (await started.json().catch(() => null)) as { error?: string } | null
    if (conflict?.error === "analysisAlreadyExists") {
      // The verdict already landed — this is a success, so read it back and print it.
      const finished = finishWith((await readAiReview()) ?? { review: null })
      if (finished !== null) return finished
      return {
        ok: false,
        message: "An AI review already exists for this session, but it could not be read back.",
      }
    }
    if (conflict?.error === "analysisAlreadyRunning") {
      // Attach to the in-flight run instead of erroring: read the job, then poll it home.
      const attached = await readAiReview()
      const finished = attached === null ? null : finishWith(attached)
      if (finished !== null) return finished
      if (attached?.job !== undefined) {
        jobId = attached.job.jobId
        startedAt = new Date(attached.job.startedAt).getTime()
        lastEvent = attached.job.lastEvent
        stderr.write(`attaching to the running analysis (job ${jobId.slice(0, 8)}…)\n`)
      } else {
        return {
          ok: false,
          message: "An analysis is already running for this session; it could not be attached to.",
        }
      }
    } else {
      return { ok: false, message: `The server refused the analysis (409).` }
    }
  } else if (started.status !== 202) {
    return { ok: false, message: `The server refused the analysis (${started.status}).` }
  } else {
    jobId = ((await started.json()) as { jobId: string }).jobId
  }

  const deadline = now().getTime() + timeoutMs
  let lastProgressAt = startedAt
  for (;;) {
    const poll = await deps
      .fetch(`${deps.apiBase}/api/sessions/${sessionId}/aireview`, {
        headers: { authorization: `Bearer ${deps.token}` },
      })
      .catch(() => null)
    if (poll === null) return { ok: false, message: `Could not reach ${deps.apiBase}.` }
    if (poll.ok) {
      const body = (await poll.json()) as AiReviewResponse
      // A 200 with a null review means the job is still running (the response carries it
      // as `job`) — the same "not yet" a 404 noAiReview has always meant.
      const finished = finishWith(body)
      if (finished !== null) return finished
    } else if (poll.status !== 404) {
      return { ok: false, message: `The server refused the AI review (${poll.status}).` }
    }
    const elapsed = now().getTime()
    if (elapsed >= deadline) {
      stderr.write(
        `Timed out after ${timeoutMs}ms waiting for the AI review of ${sessionId} (job ${jobId}) -- the job may still finish server-side. Last server event: ${formatLastEvent(lastEvent, startedAt, elapsed)}\n`,
      )
      return { ok: false }
    }
    if (elapsed - lastProgressAt >= AI_PROGRESS_INTERVAL_MS) {
      // Read the job status so the progress line names the latest pipeline milestone. A
      // missing job (404) means the registry dropped it (restart) — keep the last known
      // event so the user can still see what the run reached.
      const status = await deps
        .fetch(`${deps.apiBase}/api/sessions/${sessionId}/analyze/${jobId}`, {
          headers: { authorization: `Bearer ${deps.token}` },
        })
        .catch(() => null)
      if (status?.ok) {
        const body = (await status.json()) as {
          job?: { lastEvent?: { name: string; at: string } | null }
        }
        if (body.job?.lastEvent !== undefined) lastEvent = body.job.lastEvent
      }
      stderr.write(
        `still working (job ${jobId.slice(0, 8)}…, ${formatLastEvent(lastEvent, startedAt, elapsed)})\n`,
      )
      lastProgressAt = elapsed
    }
    await pause(AI_POLL_INTERVAL_MS)
  }
}

export type ReviewCommandOptions = {
  readonly recent?: number
  readonly ai?: boolean
  readonly json?: boolean
  readonly timeoutMs?: number
}

export const reviewCommand = async (
  sessionId: string | undefined,
  options: ReviewCommandOptions & Partial<ReviewDeps> = {},
): Promise<number> => {
  const deps: ReviewDeps = {
    apiBase: options.apiBase ?? apiBase(),
    token: options.token ?? (await readToken()),
    fetch: options.fetch ?? globalThis.fetch,
    now: options.now,
    stdout: options.stdout,
    stderr: options.stderr,
    sleep: options.sleep,
  }
  const { stdout } = resolveIo({ stdout: deps.stdout })

  if (deps.token === null) {
    stdout.write(errorMessage("Not paired. Run `samskara login` first."))
    return 1
  }
  // No pre-flight token check: every request below carries the token and reports rejection
  // itself, so a verify round-trip here is latency with no new information.

  const listed =
    sessionId === undefined ? await listRecent(Math.max(1, options.recent ?? 1), deps) : null
  if (listed !== null && "error" in listed) {
    stdout.write(errorMessage(listed.error))
    return 1
  }
  const ids = listed === null ? [sessionId as string] : listed.ids
  if (ids.length === 0) {
    stdout.write("No captured sessions yet -- nothing to review.\n")
    return 0
  }

  let failures = 0
  for (const id of ids) {
    if (ids.length > 1) stdout.write(`\n${id}\n`)
    const result =
      options.ai === true
        ? await reviewAiOne(id, deps, { json: options.json, timeoutMs: options.timeoutMs })
        : await reviewOne(id, deps)
    if (!result.ok) {
      // The AI paths that already reported on stderr (timeout, --json without lenses) return
      // no message; only the shared messages print here.
      if (result.message !== undefined) stdout.write(errorMessage(result.message))
      else if (options.ai !== true) stdout.write(errorMessage(`Reviewing ${id} failed.`))
      failures += 1
    }
  }
  return failures === 0 ? 0 : 1
}
