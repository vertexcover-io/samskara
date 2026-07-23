import type { NormalizedMessage, TokenUsage } from "../../ingest/types.js"
import type { FileSystem } from "../fs.js"
import { compact, iterJsonLines, readNewLines } from "../helpers.js"
import type { AgentPlugin, ChangedFile, CollectContext, FileState, SubagentInfo } from "../types.js"

const SOURCE = "claude_code"
const SCHEMA_VERSION = 1

const SUBAGENT_PATH = /\/subagents\/agent-[a-f0-9]+\.jsonl$/

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined)
const num = (v: unknown): number => (typeof v === "number" ? v : 0)

const providerFor = (model?: string): string | undefined =>
  model?.startsWith("claude-") ? "anthropic" : undefined

const tokensFrom = (usage: unknown): TokenUsage | undefined => {
  if (!isObject(usage)) return undefined
  return {
    input: num(usage.input_tokens),
    output: num(usage.output_tokens),
    cached: num(usage.cache_read_input_tokens),
    thinking: 0,
  }
}

type Common = {
  readonly lineUuid: string
  readonly sessionId: string
  readonly timestamp: string
  readonly lineNumber: number
  readonly model?: string
  readonly agentId?: string
  readonly parentUuid?: string
  readonly role?: string
}

const blockToMessage = (
  block: unknown,
  subIndex: number,
  common: Common,
  tokens: TokenUsage | undefined,
): NormalizedMessage | null => {
  if (!isObject(block)) return null
  const base = {
    ...common,
    subIndex,
    source: SOURCE,
    sourceSchemaVersion: SCHEMA_VERSION,
    provider: providerFor(common.model),
  }
  const type = block.type

  if (type === "text") {
    return { ...base, msgType: "assistant", content: str(block.text), tokens }
  }
  if (type === "thinking") {
    return { ...base, msgType: "assistant", thinking: str(block.thinking), tokens }
  }
  if (type === "tool_use") {
    const id = str(block.id)
    const name = str(block.name)
    if (!id || !name) return null
    return {
      ...base,
      msgType: "toolCall",
      content: JSON.stringify(block),
      toolCall: { id, name, input: block.input },
    }
  }
  if (type === "tool_result") {
    const callId = str(block.tool_use_id)
    if (!callId) return null
    const status = block.is_error === true ? "failure" : "success"
    const output = typeof block.content === "string" ? block.content : JSON.stringify(block.content)
    return {
      ...base,
      msgType: "toolResult",
      content: JSON.stringify(block),
      toolResult: { callId, output, status },
    }
  }
  return null
}

export const normalizeClaude = (
  data: unknown,
  lineNumber: number,
): ReadonlyArray<NormalizedMessage> => {
  if (!isObject(data)) return []
  const message = data.message
  if (!isObject(message)) return []

  const content = message.content
  if (!Array.isArray(content)) return []

  const common: Common = {
    lineUuid: str(data.uuid) ?? "",
    sessionId: str(data.sessionId) ?? "",
    timestamp: str(data.timestamp) ?? "",
    lineNumber,
    model: str(message.model),
    agentId: str(data.agentId),
    parentUuid: str(data.parentUuid),
    role: str(message.role),
  }
  if (common.lineUuid === "") return []

  const tokens = tokensFrom(message.usage)
  return compact(content.map((block, index) => blockToMessage(block, index, common, tokens)))
}

export const readClaudeSidecar = async (
  fs: FileSystem,
  transcriptPath: string,
): Promise<SubagentInfo | null> => {
  const metaPath = transcriptPath.replace(/\.jsonl$/, ".meta.json")
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(metaPath))
    if (!isObject(parsed)) return null
    const agentId = str(parsed.agentId)
    if (!agentId) return null
    return {
      agentId,
      agentType: str(parsed.agentType),
      description: str(parsed.description),
      spawnDepth: typeof parsed.spawnDepth === "number" ? parsed.spawnDepth : undefined,
      spawnToolUseId: str(parsed.spawnToolUseId),
      sourceRelativePath: transcriptPath,
    }
  } catch {
    return null
  }
}

const contextFrom = (
  records: ReadonlyArray<{ readonly data: unknown }>,
): CollectContext | undefined => {
  const withCwd = records.find((r) => isObject(r.data) && str(r.data.cwd))
  if (!withCwd || !isObject(withCwd.data)) return undefined
  return { cwd: str(withCwd.data.cwd), gitBranch: str(withCwd.data.gitBranch) }
}

export const createClaudePlugin = (fs: FileSystem): AgentPlugin => ({
  source: SOURCE,
  globs: ["~/.claude/projects/**/*.jsonl"],
  collect: async (changed, prev) => {
    const { lines, cursor } = await readNewLines(fs, changed.path, prev)
    const records = iterJsonLines(lines)
    const messages = records.flatMap(({ lineNumber, data }) => normalizeClaude(data, lineNumber))
    const isSubagent = SUBAGENT_PATH.test(changed.path)
    const sidecar = isSubagent ? await readClaudeSidecar(fs, changed.path) : null
    const subagents = sidecar ? [sidecar] : undefined
    const agentId = messages.find((m) => m.agentId)?.agentId ?? sidecar?.agentId ?? null
    const sessionId = messages.find((m) => m.sessionId)?.sessionId ?? prev?.sessionId ?? null
    const context = contextFrom(records)
    return {
      messages,
      subagents,
      context,
      newState: {
        filePath: changed.path,
        source: SOURCE,
        sessionId,
        type: agentId ? "subagent" : "main",
        agentId,
        retryCount: 0,
        lastError: null,
        lastMtime: changed.mtime,
        lastSize: changed.size,
        cursor,
      },
    }
  },
})
