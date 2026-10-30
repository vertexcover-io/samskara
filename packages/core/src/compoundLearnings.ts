import { z } from "zod"

/**
 * The skill writes "" for a field that does not apply. It is null from here on, so nothing past
 * the file -- the upload, the table, the page -- ever sees an empty string.
 */
const unset = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === "" ? null : value), schema.nullable().optional())

const optionalText = unset(z.string())
const transcriptLineRef = unset(z.uuid())

export const learnTriggerSchema = z.enum(["manual", "auto"])
export const learnOutcomeSchema = z.enum(["new", "occurrence", "lint", "rejected"])
export const learnStatusSchema = z.enum(["accepted", "edited", "rejected", "existing"])

// `why_triggered` → `whyTriggered`. Top-level keys only: no field holds an object.
const camelKeys = (value: unknown): unknown =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(
        Object.entries(value).map(([key, field]) => [
          key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()),
          field,
        ]),
      )
    : value

/**
 * One line of `<repo root>/.harness/learning-events/<sessionId>.jsonl` (harness plugin) or
 * `<repo root>/.yok/learning-events/<sessionId>.jsonl` (yok plugin), written by the `/learn`
 * skill each time it proposes a learning. yok writes camelCase keys; harness, and yok files written
 * before it switched, use snake_case, so keys are camelCased before the check. Unknown keys are
 * stripped rather than rejected, so a newer skill adding a field does not fail a whole upload.
 */
export const compoundLearningEventSchema = z.preprocess(
  camelKeys,
  z.object({
    eventId: z.string().min(1),
    sessionId: z.string().min(1),
    timestamp: z.iso.datetime({ offset: true }),
    cwd: optionalText,
    /** The plugin and version that wrote the event, e.g. `harness@1.33.1` or `yok@0.0.1`. */
    skillVersion: optionalText,
    trigger: learnTriggerSchema,
    whyTriggered: z.string(),
    /**
     * The Claude Code transcript line uuids of the first and last message of the exchange the
     * learning came from, or null when the skill could not tell. They match `messages.lineUuid` in
     * the session named by `sessionId`.
     */
    evidenceFromMessage: transcriptLineRef,
    evidenceToMessage: transcriptLineRef,
    optionsShown: z.array(z.string()).optional(),
    proposedLearning: z.string(),
    optionUserPicked: optionalText,
    outcome: learnOutcomeSchema,
    status: unset(learnStatusSchema),
    /** Filled only when status is "edited"; not enforced here. */
    finalLearning: optionalText,
    rejectionReason: optionalText,
    learningFile: optionalText,
    /** Path of an older learning file this one superseded and deleted. */
    replaces: optionalText,
  }),
)

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
