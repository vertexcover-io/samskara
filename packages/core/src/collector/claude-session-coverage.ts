import { readdir, readFile } from "node:fs/promises"
import { dirname, join, relative } from "node:path"
import { classifyClaudePath, normalizeClaude } from "./plugins/claude.js"

type TrackCoverage = {
  readonly sourceRelativePath: string
  readonly sourceLineCount: number
  readonly parsedRecordCount: number
  readonly normalizedMessageCount: number
}

export type ClaudeSessionCoverage = {
  readonly sessionId: string
  readonly mainTranscriptCount: 1
  readonly agentTranscriptCount: number
  readonly tracks: ReadonlyArray<TrackCoverage>
  readonly totals: {
    readonly sourceLineCount: number
    readonly parsedRecordCount: number
    readonly normalizedMessageCount: number
  }
}

type CoverageOptions = {
  readonly sessionId: string
  readonly discoveryRoot: string
}

const filesBelow = async (directory: string): Promise<ReadonlyArray<string>> => {
  const entries = await readdir(directory, { withFileTypes: true })
  const paths = await Promise.all(
    entries.map(async (entry): Promise<ReadonlyArray<string>> => {
      const path = join(directory, entry.name)
      return entry.isDirectory() ? filesBelow(path) : [path]
    }),
  )
  return paths.flat()
}

type TranscriptLine = { readonly text: string; readonly lineNumber: number }

const transcriptLines = async (path: string): Promise<ReadonlyArray<TranscriptLine>> =>
  (await readFile(path, "utf8"))
    .split(/\r?\n/)
    .flatMap((text, index) => (text.trim().length > 0 ? [{ text, lineNumber: index + 1 }] : []))

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const objectFromLine = (
  line: TranscriptLine,
  sourceRelativePath: string,
): Record<string, unknown> => {
  let value: unknown
  try {
    value = JSON.parse(line.text)
  } catch {
    throw new Error(`${sourceRelativePath}:${line.lineNumber}: invalid JSON`)
  }
  if (!isObject(value)) {
    throw new Error(`${sourceRelativePath}:${line.lineNumber}: expected JSON object`)
  }
  return value
}

const cwdFromTranscript = async (path: string, bucket: string): Promise<string | undefined> =>
  (await transcriptLines(path))
    .map((line) => objectFromLine(line, relative(bucket, path)))
    .map((value) => (typeof value.cwd === "string" && value.cwd.length > 0 ? value.cwd : undefined))
    .find((cwd) => cwd !== undefined)

const trackCoverage = async (
  path: string,
  context: {
    readonly trackId: string
    readonly agentId?: string
    readonly sourceRelativePath: string
  },
  sessionId: string,
  mainCwd: string | undefined,
): Promise<TrackCoverage> => {
  const lines = await transcriptLines(path)
  const { sourceRelativePath } = context
  const values = lines.map((line) => ({ line, value: objectFromLine(line, sourceRelativePath) }))
  const cwd =
    values
      .map(({ value }) =>
        typeof value.cwd === "string" && value.cwd.length > 0 ? value.cwd : undefined,
      )
      .find((value) => value !== undefined) ?? mainCwd
  if (!cwd && values.length > 0) {
    throw new Error(
      `${sourceRelativePath}:${values[0]?.line.lineNumber ?? 1}: unresolved attribution`,
    )
  }
  const messageCounts = values.map(({ line, value }) => {
    const embeddedSessionId =
      typeof value.sessionId === "string"
        ? value.sessionId
        : typeof value.session_id === "string"
          ? value.session_id
          : undefined
    if (embeddedSessionId && embeddedSessionId !== sessionId) {
      throw new Error(`${sourceRelativePath}:${line.lineNumber}: session attribution conflict`)
    }
    const messages = normalizeClaude(value, {
      sessionId,
      trackId: context.trackId,
      lineNumber: line.lineNumber,
      ...(context.agentId === undefined ? {} : { agentId: context.agentId }),
    })
    if (messages.length === 0) {
      throw new Error(`${sourceRelativePath}:${line.lineNumber}: normalized to zero messages`)
    }
    return messages.length
  })
  return {
    sourceRelativePath,
    sourceLineCount: lines.length,
    parsedRecordCount: messageCounts.length,
    normalizedMessageCount: messageCounts.reduce((total, count) => total + count, 0),
  }
}

export const buildClaudeSessionCoverage = async ({
  sessionId,
  discoveryRoot,
}: CoverageOptions): Promise<ClaudeSessionCoverage> => {
  const files = await filesBelow(discoveryRoot)
  const mainTranscripts = files.filter((path) => {
    const parts = relative(discoveryRoot, path).replaceAll("\\", "/").split("/")
    return parts.length === 2 && parts[1] === `${sessionId}.jsonl`
  })
  if (mainTranscripts.length !== 1) {
    throw new Error(
      `Expected exactly one main transcript for ${sessionId}; found ${mainTranscripts.length}`,
    )
  }
  const mainTranscript = mainTranscripts[0]
  if (!mainTranscript) throw new Error(`Main transcript disappeared for ${sessionId}`)
  const bucket = dirname(mainTranscript)
  const discoveryRootForBucket = dirname(bucket)
  const sessionDirectory = join(bucket, sessionId)
  const mainContext = classifyClaudePath(mainTranscript, discoveryRootForBucket)
  if (mainContext?.trackId !== "main") {
    throw new Error(`Could not classify main transcript for ${sessionId}`)
  }
  const agentTranscripts = files
    .flatMap((path) => {
      if (!path.startsWith(`${sessionDirectory}/`)) return []
      const context = classifyClaudePath(path, discoveryRootForBucket)
      return context?.sessionId === sessionId && context.agentId ? [{ path, context }] : []
    })
    .sort((left, right) => left.path.localeCompare(right.path))
  const trackPaths = [{ path: mainTranscript, context: mainContext }, ...agentTranscripts]
  const mainCwd = await cwdFromTranscript(mainTranscript, bucket)
  const tracks = await Promise.all(
    trackPaths.map(({ path, context }) => trackCoverage(path, context, sessionId, mainCwd)),
  )
  return {
    sessionId,
    mainTranscriptCount: 1,
    agentTranscriptCount: agentTranscripts.length,
    tracks,
    totals: {
      sourceLineCount: tracks.reduce((total, track) => total + track.sourceLineCount, 0),
      parsedRecordCount: tracks.reduce((total, track) => total + track.parsedRecordCount, 0),
      normalizedMessageCount: tracks.reduce(
        (total, track) => total + track.normalizedMessageCount,
        0,
      ),
    },
  }
}
