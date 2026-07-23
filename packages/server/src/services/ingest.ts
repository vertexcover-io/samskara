import type { IngestPayload, IngestResponse, NormalizedMessage, RawLine } from "@samskara/core"
import type { Db, Querier } from "../db/client.js"
import type { MessageRow } from "../repositories/messages.repo.js"
import * as messagesRepo from "../repositories/messages.repo.js"
import * as orgReposRepo from "../repositories/orgRepos.repo.js"
import * as reposRepo from "../repositories/repos.repo.js"
import * as sessionsRepo from "../repositories/sessions.repo.js"
import * as subagentsRepo from "../repositories/subagents.repo.js"
import * as tokenUsageRepo from "../repositories/tokenUsage.repo.js"
import * as toolRowsRepo from "../repositories/toolRows.repo.js"
import * as userReposRepo from "../repositories/userRepos.repo.js"

const providerFor = (model?: string): string | undefined =>
  model?.startsWith("claude-") ? "anthropic" : undefined

const toMessageRow = (
  sessionId: string,
  rawByLine: ReadonlyMap<string, string>,
  message: NormalizedMessage,
): MessageRow => ({
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
  raw: rawByLine.get(message.lineUuid) ?? {},
  sourceSchemaVersion: message.sourceSchemaVersion,
  isSubagent: message.agentId !== undefined,
  agentId: message.agentId,
})

const rawMap = (rawLines: ReadonlyArray<RawLine>): ReadonlyMap<string, string> =>
  new Map(rawLines.map((line) => [line.lineUuid, line.raw] as const))

const grantRepoAccess = async (
  tx: Querier,
  userId: string,
  payload: IngestPayload,
): Promise<string> => {
  const repoId = await reposRepo.upsertByIdentity(tx, payload.repo)
  await userReposRepo.grant(tx, userId, repoId)
  if (payload.repo.ownerType === "org") {
    const orgId = await orgReposRepo.findOrgIdBySlug(tx, payload.repo.owner)
    if (orgId) await orgReposRepo.link(tx, orgId, repoId)
  }
  return repoId
}

const deriveToolRows = async (
  tx: Querier,
  messages: ReadonlyArray<NormalizedMessage>,
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
  messages: ReadonlyArray<NormalizedMessage>,
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

export const ingest = async (
  db: Db,
  userId: string,
  payload: IngestPayload,
): Promise<IngestResponse> => {
  try {
    return await db.transaction(async (tx) => {
      const repoId = await grantRepoAccess(tx, userId, payload)

      if (payload.type === "main") {
        await sessionsRepo.upsert(tx, {
          id: payload.sessionId,
          source: "claude_code",
          userId,
          repoId,
          fields: payload.session,
        })
      } else {
        if (!(await sessionsRepo.exists(tx, payload.sessionId))) throw SESSION_NOT_FOUND
        await subagentsRepo.upsert(tx, {
          sessionId: payload.sessionId,
          sourceRelativePath: payload.sourceRelativePath,
          agent: payload.agent,
        })
      }

      const raw = rawMap(payload.rawLines)
      const rows = payload.messages.map((m) => toMessageRow(payload.sessionId, raw, m))
      const { ingested, deduped, idByKey } = await messagesRepo.insertManyIgnoreConflicts(
        tx,
        payload.sessionId,
        rows,
      )

      await deriveToolRows(tx, payload.messages, idByKey)
      await storeTokens(tx, payload.messages, idByKey)
      await subagentsRepo.resolveParentAgentIds(tx, payload.sessionId)

      return { ingested, deduped }
    })
  } catch (error) {
    if (error === SESSION_NOT_FOUND) return { error: "sessionNotFound" }
    throw error
  }
}
