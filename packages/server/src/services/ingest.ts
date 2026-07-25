import type {
  IngestPayload,
  IngestResponse,
  NormalizedMessage,
  ParsedRecord,
  TokenUsage,
} from "@samskara/core"
import type pino from "pino"
import type { Db, Querier } from "../db/client.js"
import type { MessageRow } from "../repositories/messages.repo.js"
import * as messagesRepo from "../repositories/messages.repo.js"
import * as projectsRepo from "../repositories/projects.repo.js"
import * as sessionsRepo from "../repositories/sessions.repo.js"
import * as subagentsRepo from "../repositories/subagents.repo.js"
import * as tokenUsageRepo from "../repositories/tokenUsage.repo.js"
import * as toolRowsRepo from "../repositories/toolRows.repo.js"

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

const toMessageRow = (flat: FlatMessage): MessageRow => {
  const { message } = flat
  return {
    sessionId: message.sessionId,
    lineUuid: flat.lineUuid,
    subIndex: message.subIndex,
    parentUuid: message.parentUuid,
    msgType: message.msgType,
    subType:
      message.msgType === "custom" || message.msgType === "systemEvent"
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
    gitBranch: message.gitBranch,
    gitCommit: message.gitCommit,
  }
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

export type Ctx = { readonly db: Db; readonly log: pino.Logger; readonly userId: string }

export const ingest = async (ctx: Ctx, payload: IngestPayload): Promise<IngestResponse> => {
  const { db, log, userId } = ctx
  const flat = flatten(payload.records, payload.sourceRelativePath, payload.type === "subagent")

  try {
    return await db.transaction(async (tx) => {
      const projectId = await projectsRepo.upsert(tx, {
        identity: payload.project,
        ownerId: userId,
      })
      log.info({ projectId, slug: payload.project.slug }, "Project upserted")

      if (payload.type === "main") {
        await sessionsRepo.upsert(tx, {
          id: payload.sessionId,
          source: "claude_code",
          userId,
          projectId,
          fields: { title: payload.title },
        })
      } else {
        if (!(await sessionsRepo.exists(tx, payload.sessionId))) throw SESSION_NOT_FOUND
        await subagentsRepo.upsert(tx, {
          sessionId: payload.sessionId,
          sourceRelativePath: payload.sourceRelativePath,
          agent: payload.agent,
        })
      }

      const rows = flat.map(toMessageRow)
      const { ingested, deduped, idByKey } = await messagesRepo.insertManyIgnoreConflicts(
        tx,
        payload.sessionId,
        rows,
      )
      await deriveToolRows(tx, flat, idByKey)
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
    throw error
  }
}
