import type pino from "pino"
import { z } from "zod"
import {
  type IngestPayload,
  type ParsedRecord,
  type ProjectIdentity,
  projectIdentitySchema,
  type SessionSource,
} from "../ingest/types.js"
import type { FileSystem } from "./fs.js"

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

/**
 * An opencode session's progress is a timestamp, not a file mtime: opencode writes one row per
 * session in SQLite and increments `time_updated` as messages land. Watermarking on the message
 * id the cycle last shipped means re-runs read only what is new, even after a compaction the
 * daemon never saw.
 */
export const opencodeCheckpointSchema = checkpointBaseSchema.extend({
  source: z.literal("opencode"),
  /** Session row's `time_updated` at the moment of the last successful flush. */
  timeUpdated: z.number(),
  /** Last message id shipped; cheaper than re-counting and stable across rows the server deduped. */
  lastMessageId: z.string(),
})

export const checkpointSchema = z.discriminatedUnion("source", [
  claudeCheckpointSchema,
  opencodeCheckpointSchema,
])
export const checkpointStoreSchema = z
  .object({
    checkpoints: z.record(z.string(), checkpointSchema),
    // Transcript directory -> the project it belongs to, learned while that directory's cwd still
    // existed. A worktree that has since been removed can no longer be identified from disk, and
    // its sessions would otherwise stop syncing the moment the folder goes.
    projects: z.record(z.string(), projectIdentitySchema).optional(),
  })
  .readonly()

export type CheckpointBase = z.infer<typeof checkpointBaseSchema>
export type ClaudeCheckpoint = z.infer<typeof claudeCheckpointSchema>
export type OpencodeCheckpoint = z.infer<typeof opencodeCheckpointSchema>
export type Checkpoint = z.infer<typeof checkpointSchema>
export type CheckpointStore = z.infer<typeof checkpointStoreSchema>
export type ClaudeCheckpointBody = Omit<ClaudeCheckpoint, keyof CheckpointBase>
export type OpencodeCheckpointBody = Omit<OpencodeCheckpoint, keyof CheckpointBase>
/**
 * Each plugin stamps its own `source` on the body it returns; the discriminated union on
 * `Checkpoint` carries it through. The base fields are filled by the driver after the plugin
 * decides what changed.
 */
export type CheckpointBody = ClaudeCheckpointBody | OpencodeCheckpointBody

export type CollectDeps = {
  readonly fs: FileSystem
  readonly glob: (pattern: string) => Promise<ReadonlyArray<string>>
  // Null when the directory cannot be identified -- it no longer exists, most often a removed
  // worktree. A guess is worse than nothing here: it becomes a slug that matches no project, and
  // every session under it is then dropped as "not enabled".
  readonly resolveProject: (startDir: string) => Promise<ProjectIdentity | null>
  // Handed every directory identity resolved from disk, so the caller can persist it.
  readonly rememberProject?: (dir: string, project: ProjectIdentity) => void
  readonly log: pino.Logger
  // A plugin MUST drop tracks this rejects — the driver does not filter again. Consult it as early
  // as a file's project is known, so an unenabled project costs no parsing.
  readonly shouldCapture?: (project: ProjectIdentity) => Promise<boolean>
  // The project's cutoff, or undefined for no cutoff. A session whose first line predates it is
  // skipped whole, so a captured session always carries the context that explains it.
  readonly syncFromFor?: (project: ProjectIdentity) => Promise<string | undefined>
}

export type SessionTrack = IngestPayload & {
  readonly records: ReadonlyArray<ParsedRecord>
  readonly checkpointKey: string
  readonly lastLineProcessed: number
  readonly checkpointAt: (lineNumber: number) => CheckpointBody
}

export type SessionBatch = {
  readonly sessionId: string
  readonly tracks: ReadonlyArray<SessionTrack>
}

export interface AgentPlugin {
  readonly source: SessionSource
  collect(prev: CheckpointStore, deps: CollectDeps): Promise<ReadonlyArray<SessionBatch>>
}
