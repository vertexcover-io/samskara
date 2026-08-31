import { type ApiResult, client, request } from "./client.js"
import type {
  AiReview,
  AiReviewJobStatus,
  ReviewerOptions,
  SessionLearning,
  SessionReviewSummary,
} from "./types.js"

export const fetchSessionReviews = (
  sessionId: string,
): Promise<ApiResult<ReadonlyArray<SessionReviewSummary>>> =>
  request(() => client.api.sessions[":id"].review.$get({ param: { id: sessionId } })).then(
    (result) => (result.ok ? { ok: true, data: result.data.reviews } : result),
  )

export const fetchSessionLearnings = (
  sessionId: string,
): Promise<ApiResult<ReadonlyArray<SessionLearning>>> =>
  request(() => client.api.sessions[":id"].learnings.$get({ param: { id: sessionId } })).then(
    (result) => (result.ok ? { ok: true, data: result.data.learnings } : result),
  )

/** A per-run reviewer choice from the modal; empty fields keep the server's env defaults. */
export type ReviewerChoice = {
  readonly harness?: "opencode" | "claude"
  readonly model?: string
  /** Replace an existing review instead of 409-ing — the Redo path. */
  readonly force?: boolean
}

/** Starts a harness-run analysis; 202 hands back a job id, 403/503 come back as error codes. */
export const startAiReview = (
  sessionId: string,
  choice: ReviewerChoice = {},
): Promise<ApiResult<{ readonly jobId: string }>> =>
  request(() =>
    client.api.sessions[":id"].analyze.$post({ param: { id: sessionId }, json: choice }),
  )

/** What the analyze modal offers: harnesses, their models, and whether each CLI is installed. */
export const fetchReviewerOptions = (): Promise<ApiResult<ReviewerOptions>> =>
  request(() => client.api["reviewer-options"].$get())

/**
 * One analyze job's terminal-or-not state, as GET /:id/analyze/:jobId reports it. The
 * registry is in-memory, so a 404 jobNotFound means the server restarted (or never knew the
 * id) — the caller decides what that means for its UI.
 */
export type AiReviewJobResult = {
  readonly status: "running" | "succeeded" | "failed"
  readonly jobId?: string
  readonly startedAt?: string
  readonly lastEvent?: { readonly name: string; readonly at: string } | null
  readonly reviewId?: string
  readonly code?: string
  readonly detail?: unknown
}

export const fetchAiReviewJob = async (
  sessionId: string,
  jobId: string,
): Promise<ApiResult<AiReviewJobResult | null>> => {
  const result = await request(() =>
    client.api.sessions[":id"].analyze[":jobId"].$get({ param: { id: sessionId, jobId } }),
  )
  if (result.ok) {
    const body = result.data as { job?: AiReviewJobResult }
    return { ok: true, data: body.job ?? null }
  }
  if (result.error.kind === "notFound") return { ok: true, data: null }
  return result
}

/**
 * The persisted ai-v1 review plus any job still running for the session. A 404 noAiReview
 * is "not yet" rather than a failure, which is what makes the answer pollable; a non-null
 * `job` is the reload memory — it lets a freshly loaded page rejoin a run its previous
 * incarnation started.
 */
export type AiReviewProbe = {
  readonly review: AiReview | null
  readonly job: AiReviewJobStatus | null
}

export const fetchAiReview = async (sessionId: string): Promise<ApiResult<AiReviewProbe>> => {
  const result = await request(() =>
    client.api.sessions[":id"].aireview.$get({ param: { id: sessionId } }),
  )
  if (result.ok) {
    // The server persists the validated lens payload as opaque JSON, so the row arrives as
    // JSONValue; the local AiReview types are the web's readonly view of that shape. The
    // `job` field only exists while a run is in flight.
    const body = result.data as { review?: unknown; job?: unknown }
    return {
      ok: true,
      data: {
        review: (body.review ?? null) as AiReview,
        job: (body.job ?? null) as AiReviewJobStatus | null,
      },
    }
  }
  if (result.error.kind === "notFound") return { ok: true, data: { review: null, job: null } }
  return result
}
