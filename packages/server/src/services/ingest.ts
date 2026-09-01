import type {
  GitEvent,
  IngestPayload,
  IngestResponse,
  NormalizedMessage,
  ParsedRecord,
  PullRequestEvent,
  RepoIdentity,
  TokenUsage,
} from "@samskara/core"
import { isGitCommitCommand, isPrCreateCommand, pullRequestFlags } from "@samskara/core"
import type pino from "pino"
import type { Db, Querier } from "../db/client.js"
import * as commitsRepo from "../repositories/commits.repo.js"
import type { MessageRow } from "../repositories/messages.repo.js"
import * as messagesRepo from "../repositories/messages.repo.js"
import * as projectsRepo from "../repositories/projects.repo.js"
import * as pullRequestsRepo from "../repositories/pullRequests.repo.js"
import * as reposRepo from "../repositories/repos.repo.js"
import * as sessionsRepo from "../repositories/sessions.repo.js"
import * as subagentsRepo from "../repositories/subagents.repo.js"
import * as tokenUsageRepo from "../repositories/tokenUsage.repo.js"
import * as toolRowsRepo from "../repositories/toolRows.repo.js"
import { findOrCreateProject } from "./projects.js"

type FlatMessage = {
  readonly message: NormalizedMessage
  readonly lineUuid: string
  readonly lineNumber: number
  readonly raw: unknown
  readonly sourceRelativePath: string
  readonly isSubagent: boolean
}

const flatten = (
  records: ReadonlyArray<ParsedRecord>,
  sourceRelativePath: string,
  isSubagent: boolean,
): ReadonlyArray<FlatMessage> =>
  records.flatMap((record) =>
    record.messages.map((message) => ({
      message,
      lineUuid: record.lineUuid,
      lineNumber: record.lineNumber,
      raw: record.raw,
      sourceRelativePath,
      isSubagent,
    })),
  )

type RepoIdKey = string

// A separator no host, owner or repo name can contain, so two different identities can never
// collapse onto one key.
const KEY_SEPARATOR = "\n"

// Mirrors the (host, owner, repoName) part of repos' identity -- `userId` is constant across one
// ingest.
const repoKeyOf = (repo: RepoIdentity): RepoIdKey =>
  [repo.host, repo.owner, repo.repoName].join(KEY_SEPARATOR)

/**
 * A PR's URL carries no owner type, and `ownerType` is not part of the identity key, so a
 * PR-derived repo collapses onto the same row as a cwd-derived one.
 */
const prRepoOf = (event: PullRequestEvent): RepoIdentity => ({
  host: event.host,
  owner: event.owner,
  repoName: event.repoName,
})

const repoOf = (event: GitEvent): RepoIdentity | undefined =>
  event.kind === "commit" ? event.repo : prRepoOf(event)

/**
 * Upserts each distinct repo once before the rows are mapped, so `toMessageRow` stays pure and
 * synchronous -- mirroring how the project is upserted once rather than per row.
 */
const resolveRepoIds = async (
  tx: Querier,
  flatMessages: ReadonlyArray<FlatMessage>,
  gitEvents: ReadonlyArray<GitEvent>,
  userId: string,
): Promise<ReadonlyMap<RepoIdKey, string>> => {
  const distinct = new Map<RepoIdKey, RepoIdentity>()
  for (const { message } of flatMessages) {
    if (message.repo) distinct.set(repoKeyOf(message.repo), message.repo)
  }
  for (const event of gitEvents) {
    const repo = repoOf(event)
    if (repo) distinct.set(repoKeyOf(repo), repo)
  }
  const resolved = new Map<RepoIdKey, string>()
  for (const [key, identity] of distinct) {
    resolved.set(key, await reposRepo.upsertByIdentity(tx, identity, userId))
  }
  return resolved
}

const toMessageRow = (
  flat: FlatMessage,
  repoIdByKey: ReadonlyMap<RepoIdKey, string>,
): MessageRow => {
  const { message } = flat
  return {
    sessionId: message.sessionId,
    lineUuid: flat.lineUuid,
    subIndex: message.subIndex,
    parentUuid: message.parentUuid,
    msgType: message.msgType,
    subType:
      message.msgType === "custom" ||
      message.msgType === "systemEvent" ||
      message.msgType === "message"
        ? message.subType
        : undefined,
    role: message.msgType === "message" ? message.role : undefined,
    timestamp: message.timestamp ? new Date(message.timestamp) : null,
    lineNumber: flat.lineNumber,
    source: message.source,
    sourceRelativePath: flat.sourceRelativePath,
    trackId: message.trackId,
    model: message.model,
    provider: message.provider,
    content: message.msgType === "message" ? message.content : undefined,
    details:
      message.msgType === "custom" || message.msgType === "systemEvent"
        ? undefined
        : message.details,
    raw: flat.raw,
    sourceSchemaVersion: message.sourceSchemaVersion,
    isSubagent: flat.isSubagent,
    agentId: message.agentId,
    repoId: message.repo ? repoIdByKey.get(repoKeyOf(message.repo)) : undefined,
    gitBranch: message.gitBranch,
  }
}

type StoreInput = {
  readonly sessionId: string
  readonly events: ReadonlyArray<GitEvent>
  readonly repoIdByKey: ReadonlyMap<RepoIdKey, string>
  readonly calls: ReadonlyMap<string, toolRowsRepo.StoredCall>
}

/**
 * No event is trusted: each must name a stored Bash call whose command proves the intent, and
 * `messageId` derives from that call. The call may have been persisted by an earlier payload --
 * a chunk split or a result arriving cycles after its call resolves here all the same.
 */
const verifiedCall = (
  input: StoreInput,
  callId: string,
  provesIntent: (command: string) => boolean,
): toolRowsRepo.StoredCall | null => {
  const call = input.calls.get(callId)
  if (call?.toolName !== "Bash") return null
  if (!call.command || !provesIntent(call.command)) return null
  return call
}

/**
 * A commit's repo is the one its own Bash call ran in -- never the session's or the project's,
 * because a sub-repo inside a workspace is only identifiable from the calling message's cwd.
 * The event's own repo wins when present; a candidate shipped without one falls back to the
 * stored call message's attribution. Still unresolved is dropped: `commits.repoId` is half the
 * row's identity.
 */
const storeCommits = async (tx: Querier, input: StoreInput): Promise<void> => {
  const { sessionId, events, repoIdByKey } = input

  const rows = events.flatMap((event) => {
    if (event.kind !== "commit") return []
    const call = verifiedCall(input, event.callId, isGitCommitCommand)
    if (!call) return []
    const repoId = event.repo ? repoIdByKey.get(repoKeyOf(event.repo)) : (call.repoId ?? undefined)
    if (!repoId) return []
    return [
      {
        repoId,
        sha: event.sha,
        branch: event.branch,
        subject: event.subject,
        filesChanged: event.filesChanged,
        insertions: event.insertions,
        deletions: event.deletions,
        sessionId,
        messageId: call.messageId,
      },
    ]
  })

  await commitsRepo.insertObserved(tx, rows)
}

const storePullRequests = async (tx: Querier, input: StoreInput): Promise<void> => {
  const { sessionId, events, repoIdByKey } = input

  const rows = events.flatMap((event) => {
    if (event.kind !== "pullRequest") return []
    const call = verifiedCall(input, event.callId, isPrCreateCommand)
    if (!call) return []
    const repoId = repoIdByKey.get(repoKeyOf(prRepoOf(event)))
    if (!repoId) return []
    // The number and repo come from the result; the title and branches exist only in the
    // command, which the stored call already holds for verification.
    return [
      {
        repoId,
        number: event.number,
        sessionId,
        messageId: call.messageId,
        ...pullRequestFlags(call.command ?? ""),
      },
    ]
  })

  await pullRequestsRepo.insertOpened(tx, rows)
}

const deriveToolRows = async (
  tx: Querier,
  flatMessages: ReadonlyArray<FlatMessage>,
  idByKey: ReadonlyMap<messagesRepo.MessageKey, string>,
): Promise<void> => {
  for (const flat of flatMessages) {
    const { message } = flat
    if (message.msgType !== "toolCall" && message.msgType !== "toolResult") continue
    const messageId = idByKey.get(messagesRepo.keyOf(flat.lineUuid, message.subIndex))
    if (!messageId) continue
    await toolRowsRepo.replaceForMessage(tx, messageId, {
      call: message.msgType === "toolCall" ? message.details : undefined,
      result: message.msgType === "toolResult" ? message.details : undefined,
    })
  }
}

const tokensFor = (message: NormalizedMessage): TokenUsage | undefined => {
  if (message.msgType === "usage") {
    return message.details.type === "tokens" ? message.details.tokens : undefined
  }
  return message.tokens
}

const storeTokens = async (
  tx: Querier,
  flatMessages: ReadonlyArray<FlatMessage>,
  idByKey: ReadonlyMap<messagesRepo.MessageKey, string>,
): Promise<void> => {
  for (const flat of flatMessages) {
    const tokens = tokensFor(flat.message)
    if (!tokens) continue
    const messageId = idByKey.get(messagesRepo.keyOf(flat.lineUuid, flat.message.subIndex))
    if (messageId) await tokenUsageRepo.upsert(tx, messageId, tokens)
  }
}

const SESSION_NOT_FOUND = Symbol("sessionNotFound")
const PROJECT_FORBIDDEN = Symbol("projectForbidden")

export type Ctx = { readonly db: Db; readonly log: pino.Logger; readonly userId: string }

export const ingest = async (ctx: Ctx, payload: IngestPayload): Promise<IngestResponse> => {
  const { db, log, userId } = ctx
  const flat = flatten(payload.records, payload.sourceRelativePath, payload.type === "subagent")

  try {
    return await db.transaction(async (tx) => {
      const claimed = payload.project.projectId
      if (claimed !== undefined && !(await projectsRepo.canWrite(tx, userId, claimed))) {
        throw PROJECT_FORBIDDEN
      }
      const projectId = claimed ?? (await findOrCreateProject(tx, userId, payload.project)).id
      log.info({ projectId, slug: payload.project.slug }, "Project resolved")

      if (payload.type === "main") {
        await sessionsRepo.upsert(tx, {
          id: payload.sessionId,
          source: payload.source ?? "claude_code",
          userId,
          projectId,
          fields: {
            title: payload.title,
            startCwd: payload.startCwd,
            startCommit: payload.startCommit,
          },
        })
      } else {
        if (!(await sessionsRepo.existsForUser(tx, payload.sessionId, userId))) {
          throw SESSION_NOT_FOUND
        }
        await subagentsRepo.upsert(tx, {
          sessionId: payload.sessionId,
          sourceRelativePath: payload.sourceRelativePath,
          agent: payload.agent,
        })
      }

      const gitEvents = payload.gitEvents ?? []
      const repoIdByKey = await resolveRepoIds(tx, flat, gitEvents, userId)
      const rows = flat.map((message) => toMessageRow(message, repoIdByKey))
      const { ingested, deduped, idByKey } = await messagesRepo.insertManyIgnoreConflicts(
        tx,
        payload.sessionId,
        rows,
      )
      // Tool rows are persisted before events are stored so a same-payload call is resolvable
      // by the same lookup that serves calls from earlier payloads.
      await deriveToolRows(tx, flat, idByKey)
      const storeInput = {
        sessionId: payload.sessionId,
        events: gitEvents,
        repoIdByKey,
        calls: await toolRowsRepo.callsByIds(tx, payload.sessionId, [
          ...new Set(gitEvents.map((event) => event.callId)),
        ]),
      }
      await storeCommits(tx, storeInput)
      await storePullRequests(tx, storeInput)
      await storeTokens(tx, flat, idByKey)
      await subagentsRepo.resolveParentAgentIds(tx, payload.sessionId)
      log.info(
        { sessionId: payload.sessionId, accepted: ingested, duplicates: deduped },
        "Ingestion completed",
      )
      return { ingested, deduped }
    })
  } catch (error) {
    if (error === SESSION_NOT_FOUND) return { error: "sessionNotFound" }
    if (error === PROJECT_FORBIDDEN) return { error: "projectForbidden" }
    throw error
  }
}
