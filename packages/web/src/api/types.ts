import type { InferResponseType } from "hono/client"
import type { Client } from "./client.js"

type Ok<T> = InferResponseType<T, 200>

export type SyncStatusRow = Ok<Client["api"]["sync-status"]["$get"]>["rows"][number]

export type ProjectSummary = Ok<Client["api"]["projects"]["$get"]>["projects"][number]
export type CurrentUser = Ok<Client["api"]["auth"]["me"]["$get"]>
export type PairingCode = Ok<Client["api"]["auth"]["cli-code"]["$post"]>
export type LogoutAck = Ok<Client["api"]["auth"]["logout"]["$post"]>

export type SessionListPayload = Ok<Client["api"]["sessions"]["$get"]>
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
