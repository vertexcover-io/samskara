import type { InferResponseType } from "hono/client"
import type { Client } from "./client.js"

type Ok<T> = InferResponseType<T, 200>

export type SyncStatusRow = Ok<Client["api"]["sync-status"]["$get"]>["rows"][number]

export type ProjectSummary = Ok<Client["api"]["projects"]["$get"]>["projects"][number]
export type ProjectDetail = Ok<Client["api"]["projects"][":id"]["$get"]>["project"]
export type OrgDetail = Ok<Client["api"]["orgs"][":slug"]["$get"]>["org"]
export type OrgSummary = Ok<Client["api"]["orgs"]["$get"]>["orgs"][number]
export type CurrentUser = Ok<Client["api"]["auth"]["me"]["$get"]>
export type AuthMethods = Ok<Client["api"]["auth"]["methods"]["$get"]>
export type PairingCode = Ok<Client["api"]["auth"]["cli-code"]["$post"]>
export type LogoutAck = Ok<Client["api"]["auth"]["logout"]["$post"]>

export type SessionListPayload = Ok<Client["api"]["sessions"]["$get"]>
export type ReviewerOptions = Ok<Client["api"]["reviewer-options"]["$get"]>
export type ReviewerHarnessOptions = ReviewerOptions["harnesses"][number]
export type SessionSummary = SessionListPayload["sessions"][number]
export type SessionFilterOptions = Ok<Client["api"]["sessions"]["filters"]["$get"]>
export type FilterOption = SessionFilterOptions["projects"][number]
type SessionSearchMatch = NonNullable<SessionSummary["match"]>
export type SearchSourceKind = SessionSearchMatch["sourceKind"]

type DetailBody = Ok<Client["api"]["sessions"][":id"]["$get"]>

export type SessionFacts = DetailBody["session"]
export type SessionRepo = NonNullable<SessionFacts["repo"]>
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

type LearningList = Ok<Client["api"]["learnings"]["$get"]>
export type LearningSummary = LearningList["learnings"][number]
export type LearningRun = NonNullable<LearningList["latestRun"]>
export type LearningProblem = Ok<Client["api"]["learnings"][":id"]["$get"]>["problems"][number]

export type SessionReviewSummary = Ok<
  Client["api"]["sessions"][":id"]["review"]["$get"]
>["reviews"][number]

export type ReviewerTranscriptEntry = {
  readonly at?: string
  readonly role: "user" | "assistant"
  readonly text?: string
  readonly tools?: ReadonlyArray<{ readonly name: string; readonly input: string }>
}

/** One quote a problem cites: the message span, the words, and why they prove it. */
export type ReviewProblemEvidence = {
  readonly from: string
  readonly to: string
  readonly quote: string
  readonly why: string
}

/** One problem the AI review saved, as GET /:id/aireview returns it. */
export type ReviewProblem = {
  readonly id: string
  readonly title: string
  readonly class: string
  readonly severity: string
  readonly severityReason: string
  readonly fixType: string
  readonly description: string
  readonly evidence: ReadonlyArray<ReviewProblemEvidence>
  readonly learning: string
}

/** The AI review with the problems it saved, as GET /:id/aireview returns it. */
export type ProblemsReview = {
  readonly id: string
  readonly createdAt: string
  readonly analyzedAt: string
  readonly outcome: string
  readonly friction: string
  readonly summary: string
  readonly signals: ProblemsReviewSignals | null
  readonly problems: ReadonlyArray<ReviewProblem>
}

/** The part of an AI review's signals the card reads. */
export type ProblemsReviewSignals = {
  readonly model: string
  readonly harness: string
  readonly run?: {
    /** seq → the captured message's real id (null when the record had none). */
    readonly recordIds?: ReadonlyArray<string | null>
    /** The tail of the reviewer's own output, shown when no transcript was captured. */
    readonly agentLog?: string
    /**
     * The reviewer's own session, captured from its sandbox before the workspace was
     * deleted. Absent when the harness left nothing readable.
     */
    readonly transcript?: ReadonlyArray<ReviewerTranscriptEntry>
  }
}

/** A non-terminal analysis job as GET /:id/aireview reports it alongside the review. */
export type AiReviewJobStatus = {
  readonly jobId: string
  readonly status: "running"
  readonly startedAt: string
  readonly lastEvent: { readonly name: string; readonly at: string } | null
}
