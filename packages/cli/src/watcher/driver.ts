import type {
  AgentPlugin,
  ChangedFile,
  CollectResult,
  FileState,
  FileSystem,
  IngestPayload,
  NormalizedMessage,
  ProjectIdentity,
  RawLine,
  WatcherState,
} from "@samskara/core"
import { readState, writeState } from "@samskara/core"

export const LINE_CAP = 2000

export type Clock = { now(): number }

export type WatcherConfig = {
  readonly statePath: string
  readonly projectOverride?: ProjectIdentity
}

export type WatcherDeps = {
  readonly fs: FileSystem
  readonly clock: Clock
  readonly sink: { send(payload: IngestPayload): Promise<{ status: number }> }
  readonly glob: (pattern: string) => Promise<ReadonlyArray<string>>
  readonly plugin: AgentPlugin
  readonly resolveProject: (startDir: string) => Promise<ProjectIdentity>
}

const PROJECT_UNKNOWN: ProjectIdentity = {
  name: "unknown",
  slug: "unknown",
}

const isSubagentPath = (path: string): boolean => /\/subagents\/agent-[a-f0-9]+\.jsonl$/.test(path)

const orderMainFirst = (paths: ReadonlyArray<string>): ReadonlyArray<string> =>
  [...paths].sort((a, b) => Number(isSubagentPath(a)) - Number(isSubagentPath(b)))

const rawLinesFor = (messages: ReadonlyArray<NormalizedMessage>): ReadonlyArray<RawLine> =>
  [...new Set(messages.map((m) => m.lineUuid))].map((lineUuid) => ({ lineUuid, raw: "{}" }))

const buildPayload = (
  project: ProjectIdentity,
  sessionId: string,
  changed: ChangedFile,
  result: CollectResult,
): IngestPayload => {
  const shared = {
    sessionId,
    sourceRelativePath: changed.path,
    project,
    rawLines: rawLinesFor(result.messages),
    messages: result.messages,
  }
  if (result.newState.type === "subagent") {
    const info = result.subagents?.[0]
    const agentId = result.newState.agentId ?? info?.agentId ?? ""
    return {
      ...shared,
      type: "subagent",
      agent: {
        agentId,
        agentType: info?.agentType,
        description: info?.description,
        spawnDepth: info?.spawnDepth,
        spawnToolUseId: info?.spawnToolUseId,
      },
    }
  }
  return {
    ...shared,
    type: "main",
    session: { cwd: result.context?.cwd },
  }
}

const projectFor = async (
  config: WatcherConfig,
  deps: WatcherDeps,
  result: CollectResult,
): Promise<ProjectIdentity> => {
  if (config.projectOverride) return config.projectOverride
  const cwd = result.context?.cwd
  if (!cwd) return PROJECT_UNKNOWN
  return deps.resolveProject(cwd)
}

const changedFileFor = async (
  fs: FileSystem,
  plugin: AgentPlugin,
  path: string,
): Promise<ChangedFile> => {
  const s = await fs.stat(path)
  return { path, source: plugin.source, mtime: s.mtimeMs, size: s.size }
}

const flushFile = async (
  config: WatcherConfig,
  deps: WatcherDeps,
  path: string,
  state: WatcherState,
): Promise<WatcherState> => {
  let files = state.files
  for (;;) {
    const prev = files[path] ?? null
    const changed = await changedFileFor(deps.fs, deps.plugin, path)
    const result = await deps.plugin.collect(changed, prev)

    if (result.messages.length === 0) {
      return { files: { ...files, [path]: result.newState } }
    }

    const capped = capMessages(result, prev)
    const sessionId = capped.result.newState.sessionId
    if (!sessionId) return { files }

    const project = await projectFor(config, deps, capped.result)
    const payload = buildPayload(project, sessionId, changed, capped.result)
    const { status } = await deps.sink.send(payload)
    if (status < 200 || status >= 300) return { files }

    files = { ...files, [path]: capped.result.newState }
    if (!capped.more) return { files }
  }
}

const capMessages = (
  result: CollectResult,
  prev: FileState | null,
): { readonly result: CollectResult; readonly more: boolean } => {
  const already = prev && prev.cursor.kind === "line" ? prev.cursor.lastLineProcessed : 0
  const maxLine = already + LINE_CAP
  const withinCap = result.messages.filter((m) => m.lineNumber <= maxLine)
  if (withinCap.length === result.messages.length) return { result, more: false }

  return {
    result: {
      ...result,
      messages: withinCap,
      newState: { ...result.newState, cursor: { kind: "line", lastLineProcessed: maxLine } },
    },
    more: true,
  }
}

export const runCycle = async (config: WatcherConfig, deps: WatcherDeps): Promise<WatcherState> => {
  const state = await readState(deps.fs, config.statePath)
  const discovered = (await Promise.all(deps.plugin.globs.map((g) => deps.glob(g)))).flat()
  const ordered = orderMainFirst([...new Set(discovered)])

  let next = state
  for (const path of ordered) {
    next = await flushFile(config, deps, path, next)
  }
  await writeState(deps.fs, config.statePath, next)
  return next
}
