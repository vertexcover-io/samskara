import type { IngestPayload, IngestResponse, NormalizedMessage, ParsedRecord } from "@samskara/core"
import type pino from "pino"
import type { Db, Querier } from "../db/client.js"
import type { MessageRow } from "../repositories/messages.repo.js"
import * as messagesRepo from "../repositories/messages.repo.js"
import * as projectsRepo from "../repositories/projects.repo.js"
import * as sessionsRepo from "../repositories/sessions.repo.js"
import * as subagentsRepo from "../repositories/subagents.repo.js"
import * as tokenUsageRepo from "../repositories/tokenUsage.repo.js"
import * as toolRowsRepo from "../repositories/toolRows.repo.js"

// A message enriched with its record's line-level facts — the flat unit the repos key on.
type FlatMessage = NormalizedMessage & {
  readonly lineUuid: string
  readonly lineNumber: number
  readonly raw: string
}

const providerFor = (model?: string): string | undefined =>
  model?.startsWith("claude-") ? "anthropic" : undefined

const flatten = (records: ReadonlyArray<ParsedRecord>): ReadonlyArray<FlatMessage> =>
  records.flatMap((record) =>
    record.messages.map((message) => ({
      ...message,
      lineUuid: record.lineUuid,
      lineNumber: record.lineNumber,
      raw: record.raw,
    })),
  )

const toMessageRow = (sessionId: string, message: FlatMessage): MessageRow => ({
  sessionId,
  lineUuid: message.lineUuid,
  subIndex: message.subIndex,
  parentUuid: message.parentUuid,
  msgType: message.msgType,
  role: message.role,
  timestamp: message.timestamp ? new Date(message.timestamp) : undefined,
  lineNumber: message.lineNumber,
  model: message.model,
  provider: message.provider ?? providerFor(message.model),
  content: message.content,
  thinking: message.thinking,
  raw: message.raw,
  sourceSchemaVersion: message.sourceSchemaVersion,
  isSubagent: message.agentId !== undefined,
  agentId: message.agentId,
  gitBranch: message.gitBranch,
  gitCommit: message.gitCommit,
})

const deriveToolRows = async (
  tx: Querier,
  messages: ReadonlyArray<FlatMessage>,
  idByKey: ReadonlyMap<messagesRepo.MessageKey, string>,
): Promise<void> => {
  const withTools = messages.filter((m) => m.toolCall || m.toolResult)
  for (const message of withTools) {
    const messageId = idByKey.get(messagesRepo.keyOf(message.lineUuid, message.subIndex))
    if (!messageId) continue
    await toolRowsRepo.replaceForMessage(tx, messageId, {
      call: message.toolCall,
      result: message.toolResult,
    })
  }
}

const storeTokens = async (
  tx: Querier,
  messages: ReadonlyArray<FlatMessage>,
  idByKey: ReadonlyMap<messagesRepo.MessageKey, string>,
): Promise<void> => {
  const withTokens = messages.filter((m) => m.tokens)
  for (const message of withTokens) {
    const messageId = idByKey.get(messagesRepo.keyOf(message.lineUuid, message.subIndex))
    if (!messageId || !message.tokens) continue
    await tokenUsageRepo.upsert(tx, messageId, message.tokens)
  }
}

const SESSION_NOT_FOUND = Symbol("sessionNotFound")

export type Ctx = {
  readonly db: Db
  readonly log: pino.Logger
  readonly userId: string
}

export const ingest = async (ctx: Ctx, payload: IngestPayload): Promise<IngestResponse> => {
  const { db, log, userId } = ctx
  const flat = flatten(payload.records)
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
        log.info({ sessionId: payload.sessionId }, "Session created or updated")
      } else {
        if (!(await sessionsRepo.exists(tx, payload.sessionId))) {
          log.warn(
            { sessionId: payload.sessionId },
            `No ingest session found with id: ${payload.sessionId}`,
          )
          throw SESSION_NOT_FOUND
        }
        await subagentsRepo.upsert(tx, {
          sessionId: payload.sessionId,
          sourceRelativePath: payload.sourceRelativePath,
          agent: payload.agent,
        })
        log.info(
          { sessionId: payload.sessionId, agentId: payload.agent.agentId },
          "Subagent upserted",
        )
      }

      const rows = flat.map((m) => toMessageRow(payload.sessionId, m))
      const { ingested, deduped, idByKey } = await messagesRepo.insertManyIgnoreConflicts(
        tx,
        payload.sessionId,
        rows,
      )
      log.info({ sessionId: payload.sessionId, inserted: ingested, deduped }, "Messages inserted")

      await deriveToolRows(tx, flat, idByKey)
      await storeTokens(tx, flat, idByKey)
      await subagentsRepo.resolveParentAgentIds(tx, payload.sessionId)
      log.debug({ sessionId: payload.sessionId }, "Tool rows and token usage stored")

      log.info(
        {
          sessionId: payload.sessionId,
          accepted: ingested,
          duplicates: deduped,
          eventCount: flat.length,
        },
        "Ingestion completed",
      )
      return { ingested, deduped }
    })
  } catch (error) {
    if (error === SESSION_NOT_FOUND) return { error: "sessionNotFound" }
    throw error
  }
}
