import type { InferResponseType } from "hono/client"
import type { Client } from "./client.js"

type Ok<T> = InferResponseType<T, 200>

export type SyncStatusRow = Ok<Client["api"]["sync-status"]["$get"]>["rows"][number]

export type ProjectSummary = Ok<Client["api"]["projects"]["$get"]>["projects"][number]
export type CurrentUser = Ok<Client["api"]["auth"]["me"]["$get"]>
export type AuthMethods = Ok<Client["api"]["auth"]["methods"]["$get"]>
export type PairingCode = Ok<Client["api"]["auth"]["cli-code"]["$post"]>
export type LogoutAck = Ok<Client["api"]["auth"]["logout"]["$post"]>

export type SessionListPayload = Ok<Client["api"]["sessions"]["$get"]>
export type ReviewerOptions = Ok<Client["api"]["reviewer-options"]["$get"]>
export type ReviewerHarnessOptions = ReviewerOptions["harnesses"][number]
export type SessionSummary = SessionListPayload["sessions"][number]
export type SessionFilterOptions = SessionListPayload["filterOptions"]
export type SessionRepo = NonNullable<SessionSummary["repo"]>
type SessionSearchMatch = NonNullable<SessionSummary["match"]>
export type SearchSourceKind = SessionSearchMatch["sourceKind"]

type DetailBody = Ok<Client["api"]["sessions"][":id"]["$get"]>

export type SessionFacts = DetailBody["session"]
export type RawMessage = DetailBody["messages"][number]
export type RawToolCall = DetailBody["toolCalls"][number]
export type RawSubagent = DetailBody["subagents"][number]
export type TokenTotals = DetailBody["tokenUsage"]
export type SessionCommit = DetailBody["commits"][number]
export type SessionPullRequest = DetailBody["pullRequests"][number]

export type SessionDetailPayload = Omit<
  DetailBody,
  "messages" | "toolCalls" | "commits" | "pullRequests"
> & {
  readonly messages: ReadonlyArray<RawMessage>
  readonly toolCalls: ReadonlyArray<RawToolCall>
  readonly commits: ReadonlyArray<SessionCommit>
  readonly pullRequests: ReadonlyArray<SessionPullRequest>
}

export type CapturedArtifact = Ok<
  Client["api"]["sessions"][":id"]["artifacts"]["$get"]
>["artifacts"][number]

export type SessionReviewSummary = Ok<
  Client["api"]["sessions"][":id"]["review"]["$get"]
>["reviews"][number]

export type SessionLearning = Ok<
  Client["api"]["sessions"][":id"]["learnings"]["$get"]
>["learnings"][number]

/**
 * The ai-v1 review's `signals` column, as persisted by the server after
 * `@samskara/core`'s `aiReviewPayloadSchema` accepted it. Mirrored here as local
 * readonly types — `@samskara/core` is not a web dependency, and the server hands
 * the JSON over opaque, so the web keeps its own view of the lens shapes.
 *
 * Every field the server enriches after validation (numbers, per-entry durations,
 * the run block, partial accounting) is optional: rows persisted before the
 * enrichment landed must keep rendering, so the card renders each piece only
 * when the payload actually carries it.
 */
export type AiTimelineEntryKind = "phase" | "event" | "turning-point"

export type AiTimelineEntry = {
  readonly id: string
  readonly kind: AiTimelineEntryKind
  readonly title: string
  readonly summary: string
  readonly fromSeq: number
  readonly toSeq: number
  readonly messageIds: ReadonlyArray<string>
  readonly tracks: ReadonlyArray<string>
  readonly tags?: ReadonlyArray<string>
  /** Wall-clock span of the entry, derived server-side from export timestamps. */
  readonly durationMs?: number
  /** Wall-clock offset of the entry's start from the session's first message. */
  readonly startMs?: number
}

export type AiLearningEvidence = {
  readonly seq: number
  readonly messageId: string
  readonly what: string
}

export type AiLearningAudience = "human" | "agent" | "harness"
export type AiLearningSeverity = "low" | "medium" | "high"

export type AiLearning = {
  readonly title: string
  readonly detail: string
  readonly category: string
  /** Carried by current payloads; absent on rows persisted before audiences landed. */
  readonly audience?: AiLearningAudience
  readonly severity?: AiLearningSeverity
  /** One imperative sentence: what to do differently next time. */
  readonly nextTime?: string
  /** Short measurable cost, e.g. "95s of 278s — 34% of the session". */
  readonly cost?: string
  readonly evidence: ReadonlyArray<AiLearningEvidence>
}

export type AiReviewLens =
  | { readonly lens: "timeline"; readonly entries: ReadonlyArray<AiTimelineEntry> }
  | { readonly lens: "humanLearnings"; readonly learnings: ReadonlyArray<AiLearning> }
  | { readonly lens: "agentLearnings"; readonly learnings: ReadonlyArray<AiLearning> }
  | { readonly lens: "breadcrumbs"; readonly learnings: ReadonlyArray<AiLearning> }

/**
 * Entry counts per section. Rows persisted before the breadcrumbs lens landed carry the
 * legacy `harness` key instead, so both are optional and exactly one is present.
 */
export type AiReviewCounts = {
  readonly timeline: number
  readonly human: number
  readonly agent: number
  readonly breadcrumbs?: number
  readonly harness?: number
}

/** Attached when the reviewer's claimed counts disagree with what survived parsing. */
export type AiReviewPartial = {
  readonly claimed: AiReviewCounts
  readonly parsed: AiReviewCounts
}

/** Session totals computed server-side from the export, never estimated by the reviewer. */
export type AiReviewNumbers = {
  readonly durationMs?: number
  readonly recordCount?: number
  readonly toolCallCount?: number
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly cachedTokens?: number
  readonly thinkingTokens?: number
}

export type AiReviewRunMilestone = {
  readonly milestone: string
  readonly elapsedMs: number
}

/** How the reviewer agent itself ran: milestones, healing, self-counts, and its log tail. */
export type AiReviewRun = {
  readonly startedAt: string
  readonly finishedAt: string
  readonly milestones: ReadonlyArray<AiReviewRunMilestone>
  readonly recovered: ReadonlyArray<string>
  readonly selfCounts?: AiReviewCounts
  readonly xmlBytes?: number
  readonly agentLog?: string
  /** seq → the captured message's real id (null when the record had none). */
  readonly recordIds?: ReadonlyArray<string | null>
  /**
   * The reviewer's own session, captured from its sandbox before the workspace was deleted
   * (claude's transcript jsonl, opencode's session database). Absent on rows persisted
   * before capture existed, and when the harness left nothing readable.
   */
  readonly transcript?: ReadonlyArray<ReviewerTranscriptEntry>
}

export type ReviewerTranscriptEntry = {
  readonly at?: string
  readonly role: "user" | "assistant"
  readonly text?: string
  readonly tools?: ReadonlyArray<{ readonly name: string; readonly input: string }>
}

export type AiReviewSignals = {
  readonly model: string
  readonly harness: string
  readonly lenses: ReadonlyArray<AiReviewLens>
  readonly numbers?: AiReviewNumbers
  readonly totalDurationMs?: number
  readonly run?: AiReviewRun
  readonly partial?: AiReviewPartial
}

/** One ai-v1 review as GET /:id/aireview returns it (also carried by the review list row). */
export type AiReview = {
  readonly id: string
  readonly createdAt: string
  readonly outcome: string
  readonly friction: string
  readonly summary: string
  readonly signals: AiReviewSignals | null
}

/** A non-terminal analysis job as GET /:id/aireview reports it alongside the review. */
export type AiReviewJobStatus = {
  readonly jobId: string
  readonly status: "running"
  readonly startedAt: string
  readonly lastEvent: { readonly name: string; readonly at: string } | null
}
