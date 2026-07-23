import { z } from "zod"
import type { NormalizedMessage } from "../ingest/types.js"

export type ChangedFile = {
  readonly path: string
  readonly source: string
  readonly mtime: number
  readonly size: number
}

export type SubagentInfo = {
  readonly agentId: string
  readonly agentType?: string
  readonly description?: string
  readonly spawnDepth?: number
  readonly spawnToolUseId?: string
  readonly sourceRelativePath: string
}

export const lineCursorSchema = z
  .object({
    kind: z.literal("line"),
    lastLineProcessed: z.number(),
  })
  .readonly()

export const resumeCursorSchema = lineCursorSchema

export const fileStateSchema = z
  .object({
    filePath: z.string(),
    source: z.string(),
    sessionId: z.string().nullable(),
    type: z.enum(["main", "subagent"]),
    agentId: z.string().nullable(),
    retryCount: z.number(),
    lastError: z.string().nullable(),
    lastMtime: z.number(),
    lastSize: z.number(),
    cursor: resumeCursorSchema,
  })
  .readonly()

export const watcherStateSchema = z
  .object({
    files: z.record(z.string(), fileStateSchema),
  })
  .readonly()

export type LineCursor = z.infer<typeof lineCursorSchema>
export type ResumeCursor = z.infer<typeof resumeCursorSchema>
export type FileState = z.infer<typeof fileStateSchema>
export type WatcherState = z.infer<typeof watcherStateSchema>

export type CollectContext = {
  readonly cwd?: string
  readonly gitBranch?: string
}

export type CollectResult = {
  readonly messages: ReadonlyArray<NormalizedMessage>
  readonly subagents?: ReadonlyArray<SubagentInfo>
  readonly newState: FileState
  readonly context?: CollectContext
}

export interface AgentPlugin {
  readonly source: string
  readonly globs: ReadonlyArray<string>
  collect(changed: ChangedFile, prev: FileState | null): Promise<CollectResult>
}

export type SessionContext = {
  readonly repo: {
    readonly host: string
    readonly owner: string
    readonly ownerType: "user" | "org"
    readonly repoName: string
  }
  readonly gitBranch?: string
  readonly gitCommit?: string
}
