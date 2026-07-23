import type {
  AgentInfo,
  NormalizedMessage,
  ParsedRecord,
  ProjectIdentity,
  TokenUsage,
} from "../../ingest/types.js"
import type { FileSystem } from "../fs.js"
import { compact, iterJsonLines, readNewLines } from "../helpers.js"
import type {
  AgentPlugin,
  CheckpointBody,
  CheckpointStore,
  CollectDeps,
  SessionBatch,
  SessionTrack,
} from "../types.js"

const SOURCE = "claude_code"
const SCHEMA_VERSION = 1
const GLOB = "~/.claude/projects/**/*.jsonl"

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
  readonly sessionId: string
  readonly timestamp: string
  readonly model?: string
  readonly agentId?: string
  readonly parentUuid?: string
  readonly role?: string
  readonly gitBranch?: string
  readonly gitCommit?: string
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

export const normalizeClaude = (data: unknown): ReadonlyArray<NormalizedMessage> => {
  if (!isObject(data)) return []
  const message = data.message
  if (!isObject(message)) return []

  const content = message.content
  if (!Array.isArray(content)) return []

  const common: Common = {
    sessionId: str(data.sessionId) ?? "",
    timestamp: str(data.timestamp) ?? "",
    model: str(message.model),
    agentId: str(data.agentId),
    parentUuid: str(data.parentUuid),
    role: str(message.role),
    gitBranch: str(data.gitBranch),
    gitCommit: str(data.gitSha) ?? str(data.gitCommit),
  }

  const tokens = tokensFrom(message.usage)
  return compact(content.map((block, index) => blockToMessage(block, index, common, tokens)))
}

export const readClaudeSidecar = async (
  fs: FileSystem,
  transcriptPath: string,
): Promise<AgentInfo | null> => {
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
    }
  } catch {
    return null
  }
}

type ParsedFile = {
  readonly path: string
  readonly sessionId: string | null
  readonly agent: AgentInfo | null
  readonly cwd?: string
  readonly records: ReadonlyArray<ParsedRecord>
  readonly stat: { readonly mtime: number; readonly size: number }
}

const checkpointAtFor =
  (stat: { readonly mtime: number; readonly size: number }) =>
  (lineNumber: number): CheckpointBody => ({
    source: SOURCE,
    mtime: stat.mtime,
    size: stat.size,
    lineProcessed: lineNumber,
  })

const parseFile = async (fs: FileSystem, path: string, fromLine: number): Promise<ParsedFile> => {
  const stat = await fs.stat(path)
  const { lines } = await readNewLines(fs, path, fromLine)
  const parsedLines = iterJsonLines(lines)

  const records = parsedLines.flatMap(({ lineNumber, data }): ParsedRecord[] => {
    if (!isObject(data)) return []
    const lineUuid = str(data.uuid)
    if (!lineUuid) return []
    const messages = normalizeClaude(data)
    return [{ lineUuid, lineNumber, raw: JSON.stringify(data), messages }]
  })

  const allMessages = records.flatMap((r) => r.messages)
  const sessionId = allMessages.find((m) => m.sessionId)?.sessionId || null
  const cwd = parsedLines.map((p) => p.data).find((d) => isObject(d) && str(d.cwd)) as
    | Record<string, unknown>
    | undefined
  const isSubagent = SUBAGENT_PATH.test(path)
  const agent = isSubagent ? await readClaudeSidecar(fs, path) : null

  return {
    path,
    sessionId,
    agent,
    cwd: cwd ? str(cwd.cwd) : undefined,
    records,
    stat: { mtime: stat.mtimeMs, size: stat.size },
  }
}

const isChanged = (
  prev: CheckpointStore,
  path: string,
  stat: { readonly mtime: number; readonly size: number },
): boolean => {
  const cp = prev.checkpoints[path]
  if (!cp) return true
  return cp.mtime !== stat.mtime || cp.size !== stat.size
}

const fromLineFor = (prev: CheckpointStore, path: string): number =>
  prev.checkpoints[path]?.lineProcessed ?? 0

const buildTrack = async (
  file: ParsedFile,
  sessionId: string,
  project: ProjectIdentity,
): Promise<SessionTrack> => {
  const shared = {
    sessionId,
    project,
    sourceRelativePath: file.path,
    records: file.records,
    checkpointKey: file.path,
    checkpointAt: checkpointAtFor(file.stat),
  }
  if (file.agent) {
    return { ...shared, type: "subagent", agent: file.agent }
  }
  return { ...shared, type: "main" }
}

const groupBySession = (tracks: ReadonlyArray<SessionTrack>): ReadonlyArray<SessionBatch> => {
  const bySession = new Map<string, SessionTrack[]>()
  for (const track of tracks) {
    const list = bySession.get(track.sessionId) ?? []
    list.push(track)
    bySession.set(track.sessionId, list)
  }
  return [...bySession.entries()].map(([sessionId, list]) => ({
    sessionId,
    tracks: [...list].sort((a, b) => Number(a.type === "subagent") - Number(b.type === "subagent")),
  }))
}

export const createClaudePlugin = (fs: FileSystem): AgentPlugin => ({
  source: SOURCE,
  collect: async (prev, deps) => {
    const discovered = [...new Set(await deps.glob(GLOB))]

    const changedPaths: string[] = []
    for (const path of discovered) {
      const stat = await fs.stat(path)
      if (isChanged(prev, path, { mtime: stat.mtimeMs, size: stat.size })) changedPaths.push(path)
    }

    const parsed = await Promise.all(
      changedPaths.map((path) => parseFile(fs, path, fromLineFor(prev, path))),
    )

    const tracks = compact(
      await Promise.all(
        parsed.map(async (file): Promise<SessionTrack | null> => {
          if (!file.sessionId || file.records.length === 0) return null
          if (!file.cwd) return null
          const project = await deps.resolveProject(file.cwd)
          return buildTrack(file, file.sessionId, project)
        }),
      ),
    )

    return groupBySession(tracks)
  },
})
