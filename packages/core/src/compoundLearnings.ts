import { z } from "zod"

const transcriptLineRef = z.union([z.literal(""), z.uuid()]).optional()

export const learnTriggerSchema = z.enum(["manual", "auto"])
export const learnOutcomeSchema = z.enum(["new", "occurrence", "lint", "rejected"])
/** "" is what the skill writes when a status does not apply; it is stored as null. */
export const learnStatusSchema = z.enum(["accepted", "edited", "rejected", "existing"])

/**
 * One line of `<repo root>/.harness/learning-events/<session_id>.jsonl` (harness plugin) or
 * `<repo root>/.yok/learning-events/<session_id>.jsonl` (yok plugin), written by the `/learn`
 * skill each time it proposes a learning. Keys stay snake_case because that is
 * the file format the skill writes; the server maps them onto camelCase columns. Unknown keys are
 * stripped rather than rejected, so a newer skill adding a field does not fail a whole upload.
 */
export const compoundLearningEventSchema = z.object({
  event_id: z.string().min(1),
  session_id: z.string().min(1),
  timestamp: z.iso.datetime({ offset: true }),
  cwd: z.string().optional(),
  /** The plugin and version that wrote the event, e.g. `harness@1.33.1` or `yok@0.0.1`. */
  skill_version: z.string().optional(),
  trigger: learnTriggerSchema,
  why_triggered: z.string(),
  /**
   * The Claude Code transcript line uuids of the first and last message of the exchange the
   * learning came from, or "" when the skill could not tell. They match `messages.lineUuid` in
   * the session named by `session_id`.
   */
  evidence_from_message: transcriptLineRef,
  evidence_to_message: transcriptLineRef,
  options_shown: z.array(z.string()).optional(),
  proposed_learning: z.string(),
  option_user_picked: z.string().optional(),
  outcome: learnOutcomeSchema,
  status: z.union([learnStatusSchema, z.literal("")]).optional(),
  /** Filled only when status is "edited"; not enforced here. */
  final_learning: z.string().optional(),
  rejection_reason: z.string().optional(),
  learning_file: z.string().optional(),
  /** Path of an older learning file this one superseded and deleted. */
  replaces: z.string().optional(),
})

export type CompoundLearningEvent = z.infer<typeof compoundLearningEventSchema>

/** Events per POST. The watcher chunks to this; the server refuses anything larger. */
export const COMPOUND_LEARNINGS_BATCH_MAX = 500

export const pushCompoundLearningsRequestSchema = z.object({
  events: z.array(compoundLearningEventSchema).min(1).max(COMPOUND_LEARNINGS_BATCH_MAX),
})

export const pushCompoundLearningsResponseSchema = z.object({
  inserted: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
})

export type PushCompoundLearningsResponse = z.infer<typeof pushCompoundLearningsResponseSchema>

export type LearnTrigger = z.infer<typeof learnTriggerSchema>
export type LearnOutcome = z.infer<typeof learnOutcomeSchema>
export type LearnStatus = z.infer<typeof learnStatusSchema>
