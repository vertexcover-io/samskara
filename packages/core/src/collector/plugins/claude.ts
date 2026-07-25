import type {
  AgentInfo,
  NormalizedMessage,
  ParsedRecord,
  ProjectIdentity,
  TokenUsage,
} from "../../ingest/types.js"
import type { FileSystem } from "../fs.js"
import { type NumberedLine, compact, iterJsonLines, readNewLines } from "../helpers.js"
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

const SUBAGENT_PATH = /(?:^|[/\\])subagents[/\\]agent-([a-f0-9]+)\.jsonl$/

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined)
const num = (v: unknown): number => (typeof v === "number" ? v : 0)

const providerFor = (model?: string): string | undefined =>
  model?.startsWith("claude-") ? "anthropic" : undefined

const textMessageType = (role?: string): "user" | "assistant" | "system" => {
  if (role === "user") return "user"
  if (role === "system") return "system"
  return "assistant"
}

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
    return { ...base, msgType: textMessageType(common.role), content: str(block.text), tokens }
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

  const content = message.content
  const tokens = tokensFrom(message.usage)
  if (typeof content === "string") {
    return compact([blockToMessage({ type: "text", text: content }, 0, common, tokens)])
  }
  if (!Array.isArray(content)) return []
  return compact(content.map((block, index) => blockToMessage(block, index, common, tokens)))
}

const agentIdFromPath = (transcriptPath: string): string | undefined =>
  SUBAGENT_PATH.exec(transcriptPath)?.[1]

export const readClaudeSidecar = async (
  fs: FileSystem,
  transcriptPath: string,
): Promise<AgentInfo | null> => {
  const pathAgentId = agentIdFromPath(transcriptPath)
  if (!pathAgentId) return null

  const metaPath = transcriptPath.replace(/\.jsonl$/, ".meta.json")
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(metaPath))
    if (!isObject(parsed)) return { agentId: pathAgentId }
    return {
      agentId: str(parsed.agentId) ?? pathAgentId,
      agentType: str(parsed.agentType),
      description: str(parsed.description),
      spawnDepth: typeof parsed.spawnDepth === "number" ? parsed.spawnDepth : undefined,
      spawnToolUseId: str(parsed.toolUseId) ?? str(parsed.spawnToolUseId),
    }
  } catch {
    return { agentId: pathAgentId }
  }
}

type ParsedFile = {
  readonly path: string
  readonly sessionId: string | null
  readonly agent: AgentInfo | null
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

// Stop at the first line carrying a cwd — early lines can be mode/snapshot records that have none,
// and the transcript's own content is the only faithful source. The `-Users-me-my-app` directory
// name can't be reversed: `/` and a literal `-` in a path segment both encode to `-`.
const cwdOf = (lines: ReadonlyArray<NumberedLine>): string | undefined => {
  for (const { text } of lines) {
    const trimmed = text.trim()
    if (trimmed.length === 0) continue
    try {
      const data: unknown = JSON.parse(trimmed)
      if (!isObject(data)) continue
      const cwd = str(data.cwd)
      if (cwd) return cwd
    } catch {}
  }
  return undefined
}

// `~/.claude/projects/<encoded-cwd>/…` — every transcript below one encoded dir shares a cwd,
// including the `subagents/` children, so this is the unit a project is resolved for.
const PROJECT_DIR = /^(.*[/\\]projects[/\\][^/\\]+)(?:[/\\]|$)/

const projectDirOf = (path: string): string =>
  PROJECT_DIR.exec(path)?.[1] ?? path.replace(/[/\\][^/\\]*$/, "")

const parseFile = async (fs: FileSystem, path: string, fromLine: number): Promise<ParsedFile> => {
  const stat = await fs.stat(path)
  const { lines } = await readNewLines(fs, path, fromLine)

  const records = iterJsonLines(lines).flatMap(({ lineNumber, data }): ParsedRecord[] => {
    if (!isObject(data)) return []
    const lineUuid = str(data.uuid)
    if (!lineUuid) return []
    const messages = normalizeClaude(data)
    return [{ lineUuid, lineNumber, raw: JSON.stringify(data), messages }]
  })

  const sessionId = records.flatMap((r) => r.messages).find((m) => m.sessionId)?.sessionId || null
  const agent = SUBAGENT_PATH.test(path) ? await readClaudeSidecar(fs, path) : null

  return { path, sessionId, agent, records, stat: { mtime: stat.mtimeMs, size: stat.size } }
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

const groupByProjectDir = (
  paths: ReadonlyArray<string>,
): ReadonlyMap<string, ReadonlyArray<string>> => {
  const byDir = new Map<string, string[]>()
  for (const path of paths) {
    const dir = projectDirOf(path)
    const list = byDir.get(dir) ?? []
    list.push(path)
    byDir.set(dir, list)
  }
  return byDir
}

// Resumed transcripts can have no cwd among their new lines, so probe siblings until one answers
// rather than stranding the whole directory on the first miss.
const cwdForDir = async (
  fs: FileSystem,
  paths: ReadonlyArray<string>,
  prev: CheckpointStore,
): Promise<string | undefined> => {
  for (const path of paths) {
    const { lines } = await readNewLines(fs, path, fromLineFor(prev, path))
    const cwd = cwdOf(lines)
    if (cwd) return cwd
  }
  return undefined
}

// A directory's identity is fixed — its encoded cwd never changes and neither, in practice, does
// its git remote — so the probe read and the git-backed resolve are done once for the daemon's
// lifetime. Enablement is deliberately not cached: it is re-checked against the live registry
// every cycle so toggling a project takes effect on the next one.
type ProjectCache = Map<string, Promise<ProjectIdentity | null>>

const projectForDir = (
  cache: ProjectCache,
  fs: FileSystem,
  dir: string,
  paths: ReadonlyArray<string>,
  prev: CheckpointStore,
  resolve: (startDir: string) => Promise<ProjectIdentity>,
): Promise<ProjectIdentity | null> => {
  const hit = cache.get(dir)
  if (hit) return hit

  const pending = cwdForDir(fs, paths, prev).then((cwd) => (cwd ? resolve(cwd) : null))
  cache.set(dir, pending)

  // A directory with no cwd yet (a transcript opened but not written to) must stay retryable.
  return pending.then((project) => {
    if (!project) cache.delete(dir)
    return project
  })
}

// Decide per session directory, from a single probe file, before any transcript is normalized: a
// directory whose project is disabled is dropped here, so its remaining transcripts are never read.
const resolveEnabledDirs = async (
  cache: ProjectCache,
  fs: FileSystem,
  changedPaths: ReadonlyArray<string>,
  prev: CheckpointStore,
  deps: CollectDeps,
): Promise<ReadonlyMap<string, ProjectIdentity>> => {
  const resolved = await Promise.all(
    [...groupByProjectDir(changedPaths)].map(
      async ([dir, paths]): Promise<readonly [string, ProjectIdentity] | null> => {
        const project = await projectForDir(cache, fs, dir, paths, prev, deps.resolveProject)
        if (!project) return null
        if (deps.shouldCapture && !(await deps.shouldCapture(project))) return null
        return [dir, project]
      },
    ),
  )

  return new Map(compact(resolved))
}

const buildTrack = (
  file: ParsedFile,
  sessionId: string,
  project: ProjectIdentity,
): SessionTrack => {
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

export const createClaudePlugin = (fs: FileSystem): AgentPlugin => {
  const projectCache: ProjectCache = new Map()

  return {
    source: SOURCE,
    collect: async (prev, deps) => {
      const discovered = [...new Set(await deps.glob(GLOB))]

      const changedPaths: string[] = []
      for (const path of discovered) {
        const stat = await fs.stat(path)
        if (isChanged(prev, path, { mtime: stat.mtimeMs, size: stat.size })) changedPaths.push(path)
      }

      const enabledDirs = await resolveEnabledDirs(projectCache, fs, changedPaths, prev, deps)

      const tracks = compact(
        await Promise.all(
          changedPaths.map(async (path): Promise<SessionTrack | null> => {
            const project = enabledDirs.get(projectDirOf(path))
            if (!project) return null

            const parsed = await parseFile(fs, path, fromLineFor(prev, path))
            if (!parsed.sessionId || parsed.records.length === 0) return null
            return buildTrack(parsed, parsed.sessionId, project)
          }),
        ),
      )

      return groupBySession(tracks)
    },
  }
}
