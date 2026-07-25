import type pino from "pino"
import { z } from "zod"
import type { IngestPayload, ParsedRecord, ProjectIdentity } from "../ingest/types.js"
import type { FileSystem } from "./fs.js"

export const checkpointBaseSchema = z.object({
  filePath: z.string(),
  lastUpdatedAt: z.string(),
})

export const claudeCheckpointSchema = checkpointBaseSchema.extend({
  source: z.literal("claude_code"),
  mtime: z.number(),
  size: z.number(),
  lineProcessed: z.number(),
})

export const checkpointSchema = claudeCheckpointSchema
export const checkpointStoreSchema = z
  .object({ checkpoints: z.record(z.string(), checkpointSchema) })
  .readonly()

export type CheckpointBase = z.infer<typeof checkpointBaseSchema>
export type ClaudeCheckpoint = z.infer<typeof claudeCheckpointSchema>
export type Checkpoint = z.infer<typeof checkpointSchema>
export type CheckpointStore = z.infer<typeof checkpointStoreSchema>
export type CheckpointBody = Omit<ClaudeCheckpoint, keyof CheckpointBase>

export type LineOutcome =
  | { readonly kind: "record"; readonly lineNumber: number; readonly record: ParsedRecord }
  | {
      readonly kind: "skip"
      readonly lineNumber: number
      readonly reason: "blank" | "malformedJson" | "nonObjectJson"
    }
  | {
      readonly kind: "blocked"
      readonly lineNumber: number
      readonly reason: "unresolvedAttribution" | "contextConflict"
    }

export type CollectDeps = {
  readonly fs: FileSystem
  readonly glob: (pattern: string) => Promise<ReadonlyArray<string>>
  readonly resolveProject: (startDir: string) => Promise<ProjectIdentity>
  readonly log: pino.Logger
}

type TrackTransport = {
  readonly checkpointKey: string
  readonly outcomes: ReadonlyArray<LineOutcome>
  readonly checkpointAt: (lineNumber: number) => CheckpointBody
}

export type IngestSessionTrack = IngestPayload &
  TrackTransport & {
    readonly kind: "ingest"
    readonly records: ReadonlyArray<ParsedRecord>
  }

export type CheckpointOnlyTrack = TrackTransport & {
  readonly kind: "checkpointOnly"
  readonly type: "main"
  readonly sessionId: string
  readonly sourceRelativePath: string
  readonly records: readonly []
}

export type SessionTrack = IngestSessionTrack | CheckpointOnlyTrack

export type SessionBatch = {
  readonly sessionId: string
  readonly tracks: ReadonlyArray<SessionTrack>
}

export interface AgentPlugin {
  readonly source: string
  collect(prev: CheckpointStore, deps: CollectDeps): Promise<ReadonlyArray<SessionBatch>>
}
