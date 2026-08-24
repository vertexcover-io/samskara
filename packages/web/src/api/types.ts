import type { InferResponseType } from "hono/client"
import type { Client } from "./client.js"

export type Ok<T> = InferResponseType<T, 200>

export type SyncStatusRow = Ok<Client["api"]["sync-status"]["$get"]>["rows"][number]

export type ProjectSummary = Ok<Client["api"]["projects"]["$get"]>["projects"][number]
export type CurrentUser = Ok<Client["api"]["auth"]["me"]["$get"]>
export type PairingCode = Ok<Client["api"]["auth"]["cli-code"]["$post"]>
export type LogoutAck = Ok<Client["api"]["auth"]["logout"]["$post"]>

export type SessionListPayload = Ok<Client["api"]["sessions"]["$get"]>
export type SessionSummary = SessionListPayload["sessions"][number]
export type SessionPagination = SessionListPayload["pagination"]
export type SessionFilterOptions = SessionListPayload["filterOptions"]
export type FilterOption = SessionFilterOptions["projects"][number]
export type RepositoryFilterOption = SessionFilterOptions["repositories"][number]
export type SessionRepo = NonNullable<SessionSummary["repo"]>
export type SessionSearchMatch = NonNullable<SessionSummary["match"]>
export type SearchSourceKind = SessionSearchMatch["sourceKind"]

/**
 * Restore a field the server declares as `unknown`. Hono's `JSONParsed` maps `unknown` to
 * `never`, which would make every read of the field a dead branch that still compiles.
 */
type Opaque<T, K extends keyof T> = Omit<T, K> & { readonly [P in K]: unknown }

type DetailBody = Ok<Client["api"]["sessions"][":id"]["$get"]>

export type SessionFacts = DetailBody["session"]
export type RawMessage = Opaque<DetailBody["messages"][number], "content" | "details">
export type RawToolCall = Opaque<DetailBody["toolCalls"][number], "toolInput" | "result">
export type RawSubagent = DetailBody["subagents"][number]
export type TokenTotals = DetailBody["tokenUsage"]
export type SessionCommit = DetailBody["commits"][number]
export type SessionPullRequest = DetailBody["pullRequests"][number]

export type SessionDetailPayload = Omit<DetailBody, "messages" | "toolCalls"> & {
  readonly messages: ReadonlyArray<RawMessage>
  readonly toolCalls: ReadonlyArray<RawToolCall>
}

export type CapturedArtifact = Ok<
  Client["api"]["sessions"][":id"]["artifacts"]["$get"]
>["artifacts"][number]
