import { z } from "zod"
import type { IngestPayload, ParsedRecord, ProjectIdentity } from "../ingest/types.js"
import type { FileSystem } from "./fs.js"

// Framework-owned base — present on every checkpoint regardless of plugin. `source` is the discriminant.
export const checkpointBaseSchema = z.object({
  filePath: z.string(),
  lastUpdatedAt: z.string(),
  projectSlug: z.string().optional(),
})

export const claudeCheckpointSchema = checkpointBaseSchema.extend({
  source: z.literal("claude_code"),
  mtime: z.number(),
  size: z.number(),
  lineProcessed: z.number(),
})

export const checkpointSchema = claudeCheckpointSchema
export const checkpointStoreSchema = z
  .object({
    checkpoints: z.record(z.string(), checkpointSchema),
  })
  .readonly()

export type CheckpointBase = z.infer<typeof checkpointBaseSchema>
export type ClaudeCheckpoint = z.infer<typeof claudeCheckpointSchema>
export type Checkpoint = z.infer<typeof checkpointSchema>
export type CheckpointStore = z.infer<typeof checkpointStoreSchema>

// What checkpointAt returns — the plugin's arm minus the framework-owned base fields.
export type CheckpointBody = Omit<ClaudeCheckpoint, keyof CheckpointBase>

export type CollectDeps = {
  readonly fs: FileSystem
  readonly glob: (pattern: string) => Promise<ReadonlyArray<string>>
  readonly resolveProject: (startDir: string) => Promise<ProjectIdentity>
  // A plugin MUST drop tracks this rejects — the driver does not filter again. Consult it as early
  // as a file's project is known, so an unenabled project costs no parsing.
  readonly shouldCapture?: (project: ProjectIdentity) => Promise<boolean>
}

// One participant's freshly-parsed, not-yet-sent work — an IngestPayload plus transport-only fields.
export type SessionTrack = IngestPayload & {
  readonly checkpointKey: string
  readonly records: ReadonlyArray<ParsedRecord>
  readonly checkpointAt: (lineNumber: number) => CheckpointBody
}

export type SessionBatch = {
  readonly sessionId: string
  readonly tracks: ReadonlyArray<SessionTrack>
}

export interface AgentPlugin {
  readonly source: string
  collect(prev: CheckpointStore, deps: CollectDeps): Promise<ReadonlyArray<SessionBatch>>
}
