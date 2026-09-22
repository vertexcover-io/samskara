import { z } from "zod"
import { REVIEW_FRICTIONS, REVIEW_OUTCOMES } from "../events.js"

/** What a timeline entry is: a stretch of work, a single occurrence, or the moment things turned. */
export const TIMELINE_ENTRY_KINDS = ["phase", "event", "turning-point"] as const

/** Lessons addressed to the human who supervised the session. */
export const HUMAN_LEARNING_CATEGORIES = [
  "communication",
  "context",
  "course-correction",
  "task-shape",
] as const

/** Lessons addressed to the agent that did the work. */
export const AGENT_LEARNING_CATEGORIES = ["efficiency", "approach", "tool-use", "process"] as const

/**
 * Breadcrumbs: standard, reusable discoveries the run turned up — a query, command, file
 * path, or procedure the next agent can reach for instead of rediscovering it. Distinct
 * from agent lessons: a breadcrumb is not a correction, it is a map marker.
 */
export const BREADCRUMB_CATEGORIES = ["query", "command", "path", "procedure", "tool"] as const

/** How much the learned mistake cost, as triage signal — not a bug tracker. */
export const LEARNING_SEVERITIES = ["low", "medium", "high"] as const

/** Learnings carry their own audience; the lens section must agree (enforced per lens). */
export const REVIEW_LEARNING_AUDIENCES = ["human", "agent", "harness"] as const

/**
 * Titles starting with this prefix are explicit nothing-entries ("Nothing to change for the
 * human"): the audience was considered and came up empty. They may carry an empty nextTime
 * and no evidence — every other learning must have both.
 */
export const NOTHING_TO_CHANGE_PREFIX = "Nothing to change"

/**
 * Array bounds for the whole payload. A grounded review is persisted into a jsonb column, so
 * "every citation resolves" is not enough on its own -- a model can cite `msg-0` a thousand
 * times per entry and pass the gate. The contract asks for about 8 timeline entries and a
 * handful of learnings, so these are generous ceilings, not targets.
 */
export const MAX_TIMELINE_ENTRIES = 200
export const MAX_LEARNINGS_PER_LENS = 200
export const MAX_MESSAGE_IDS_PER_ENTRY = 100
export const MAX_EVIDENCE_PER_LEARNING = 50
export const MAX_TRACKS_PER_ENTRY = 20
export const MAX_TAGS_PER_ENTRY = 20

const nonemptyString = z.string().min(1)
const nonnegativeInteger = z.number().int().nonnegative()

/** Short kebab-case slug, unique within its lens. */
const entryId = nonemptyString
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "kebab-case slug required")

export const timelineEntrySchema = z
  .object({
    id: entryId,
    kind: z.enum(TIMELINE_ENTRY_KINDS),
    title: nonemptyString.max(120),
    summary: nonemptyString.max(600),
    fromSeq: nonnegativeInteger,
    toSeq: nonnegativeInteger,
    messageIds: z.array(nonemptyString).min(1).max(MAX_MESSAGE_IDS_PER_ENTRY),
    tracks: z.array(nonemptyString).max(MAX_TRACKS_PER_ENTRY).default([]),
    tags: z.array(nonemptyString).max(MAX_TAGS_PER_ENTRY).optional(),
  })
  .strict()
  .superRefine((entry, ctx) => {
    if (entry.toSeq < entry.fromSeq) {
      ctx.addIssue({ code: "custom", path: ["toSeq"], message: "toSeq must be >= fromSeq" })
    }
  })

/**
 * The strictly-ascending wording lives here because two independent checks report it: this
 * refinement and the grounding gate, which audits the payload a second time on purpose.
 */
export const ascendingMessage = (previous: number): string =>
  `fromSeq must be strictly ascending (previous entry starts at ${previous})`

/**
 * The timeline lens. Entries may overlap in span (a phase contains events) but must be listed
 * in strictly ascending fromSeq order with unique ids — the order is the narrative. Durations
 * are derived server-side from export `ts`; the model never claims them.
 */
export const timelineLensSchema = z
  .object({
    lens: z.literal("timeline"),
    entries: z.array(timelineEntrySchema).min(1).max(MAX_TIMELINE_ENTRIES),
  })
  .strict()
  .superRefine((lens, ctx) => {
    const seenIds = new Set<string>()
    let previous: number | undefined
    for (const [index, entry] of lens.entries.entries()) {
      if (seenIds.has(entry.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["entries", index, "id"],
          message: `duplicate entry id "${entry.id}"`,
        })
      }
      seenIds.add(entry.id)
      if (previous !== undefined && entry.fromSeq <= previous) {
        ctx.addIssue({
          code: "custom",
          path: ["entries", index, "fromSeq"],
          message: ascendingMessage(previous),
        })
      }
      previous = entry.fromSeq
    }
  })

const learningEvidenceSchema = z
  .object({
    seq: nonnegativeInteger,
    messageId: nonemptyString,
    what: nonemptyString.max(200),
  })
  .strict()

const isNothingEntry = (title: string): boolean => title.startsWith(NOTHING_TO_CHANGE_PREFIX)

/**
 * Rules shared by every learning, whatever its audience: a real learning says what to do
 * differently next time and points at the transcript; only an explicit nothing-entry may be
 * empty. Applied per lens schema (audience and category enums differ per lens).
 */
const refineLearning = (
  learning: { title: string; nextTime?: string; evidence: unknown[] },
  ctx: z.RefinementCtx,
): void => {
  if (isNothingEntry(learning.title)) return
  if (learning.nextTime === undefined || learning.nextTime.trim() === "") {
    ctx.addIssue({
      code: "custom",
      path: ["nextTime"],
      message: `nextTime is required (one imperative sentence) unless the title starts with "${NOTHING_TO_CHANGE_PREFIX}"`,
    })
  }
  if (learning.evidence.length === 0) {
    ctx.addIssue({
      code: "custom",
      path: ["evidence"],
      message: `at least one evidence ref is required unless the title starts with "${NOTHING_TO_CHANGE_PREFIX}"`,
    })
  }
}

const learningShape = {
  title: nonemptyString.max(120),
  detail: nonemptyString.max(600),
  /** One imperative sentence: what to do differently next time. */
  nextTime: z.string().max(300).optional(),
  /** Short measurable cost, e.g. "95s of 278s — 34% of the session". Optional: often unmeasurable. */
  cost: z.string().max(120).optional(),
  severity: z.enum(LEARNING_SEVERITIES),
  evidence: z.array(learningEvidenceSchema).max(MAX_EVIDENCE_PER_LEARNING),
}

export const humanLearningsLensSchema = z
  .object({
    lens: z.literal("humanLearnings"),
    learnings: z
      .object({
        ...learningShape,
        category: z.enum(HUMAN_LEARNING_CATEGORIES),
        audience: z.literal("human"),
      })
      .strict()
      .superRefine(refineLearning)
      .array()
      .max(MAX_LEARNINGS_PER_LENS),
  })
  .strict()

export const agentLearningsLensSchema = z
  .object({
    lens: z.literal("agentLearnings"),
    learnings: z
      .object({
        ...learningShape,
        category: z.enum(AGENT_LEARNING_CATEGORIES),
        audience: z.literal("agent"),
      })
      .strict()
      .superRefine(refineLearning)
      .array()
      .max(MAX_LEARNINGS_PER_LENS),
  })
  .strict()

export const breadcrumbsLensSchema = z
  .object({
    lens: z.literal("breadcrumbs"),
    learnings: z
      .object({
        ...learningShape,
        category: z.enum(BREADCRUMB_CATEGORIES),
        audience: z.literal("agent"),
      })
      .strict()
      .superRefine(refineLearning)
      .array()
      .max(MAX_LEARNINGS_PER_LENS),
  })
  .strict()

export const aiReviewLensSchema = z.union([
  timelineLensSchema,
  humanLearningsLensSchema,
  agentLearningsLensSchema,
  breadcrumbsLensSchema,
])

/**
 * The lenses array: timeline exactly once, each learnings lens exactly once. Cardinality is a
 * refinement on the array rather than the object so a zod error points inside `lenses`.
 */
const lensesSchema = z.array(aiReviewLensSchema).superRefine((lenses, ctx) => {
  const countOf = (name: string) => lenses.filter((lens) => lens.lens === name).length
  if (countOf("timeline") !== 1) {
    ctx.addIssue({ code: "custom", message: "timeline lens is required exactly once" })
  }
  for (const name of ["humanLearnings", "agentLearnings", "breadcrumbs"]) {
    if (countOf(name) !== 1) {
      ctx.addIssue({ code: "custom", message: `${name} lens must appear exactly once` })
    }
  }
})

/** Entry counts per section, as the reviewer self-reports in `<counts>` and as parsed. */
export const reviewCountsSchema = z
  .object({
    timeline: nonnegativeInteger,
    human: nonnegativeInteger,
    agent: nonnegativeInteger,
    breadcrumbs: nonnegativeInteger,
  })
  .strict()

/**
 * Accounting block attached when the reviewer's claimed counts differ from what actually
 * parsed — the loud replacement for silently dropping half a deliverable.
 */
export const reviewPartialSchema = z
  .object({
    claimed: reviewCountsSchema,
    parsed: reviewCountsSchema,
  })
  .strict()

/**
 * What an external harness agent must produce for a session review. Strict everywhere: an
 * unknown key, lens discriminator, category or enum value is a hard rejection, because the
 * server persists this JSON only after both this schema and `validateGrounding` accept it.
 */
export const aiReviewPayloadSchema = z
  .object({
    analyzer: z.literal("ai-v1"),
    model: nonemptyString,
    harness: nonemptyString,
    outcome: z.enum(REVIEW_OUTCOMES),
    friction: z.enum(REVIEW_FRICTIONS),
    summary: nonemptyString.max(600),
    lenses: lensesSchema,
    /** Present only when the reviewer's `<counts>` disagree with what survived parsing. */
    partial: reviewPartialSchema.optional(),
  })
  .strict()

export type TimelineEntryKind = (typeof TIMELINE_ENTRY_KINDS)[number]
export type HumanLearningCategory = (typeof HUMAN_LEARNING_CATEGORIES)[number]
export type AgentLearningCategory = (typeof AGENT_LEARNING_CATEGORIES)[number]
export type BreadcrumbLearningCategory = (typeof BREADCRUMB_CATEGORIES)[number]
export type LearningSeverity = (typeof LEARNING_SEVERITIES)[number]
export type ReviewLearningAudience = (typeof REVIEW_LEARNING_AUDIENCES)[number]

export type TimelineEntry = z.infer<typeof timelineEntrySchema>
export type TimelineLens = z.infer<typeof timelineLensSchema>
export type LearningEvidence = z.infer<typeof learningEvidenceSchema>
export type HumanLearning = z.infer<typeof humanLearningsLensSchema>["learnings"][number]
export type HumanLearningsLens = z.infer<typeof humanLearningsLensSchema>
export type AgentLearning = z.infer<typeof agentLearningsLensSchema>["learnings"][number]
export type AgentLearningsLens = z.infer<typeof agentLearningsLensSchema>
export type BreadcrumbLearning = z.infer<typeof breadcrumbsLensSchema>["learnings"][number]
export type BreadcrumbsLens = z.infer<typeof breadcrumbsLensSchema>
export type AiReviewLearning = HumanLearning | AgentLearning | BreadcrumbLearning
export type AiReviewLens = z.infer<typeof aiReviewLensSchema>
export type ReviewCounts = z.infer<typeof reviewCountsSchema>
export type ReviewPartial = z.infer<typeof reviewPartialSchema>
export type AiReviewPayload = z.infer<typeof aiReviewPayloadSchema>
/** The pre-validation shape: what a producer hands `aiReviewPayloadSchema.parse`. */
export type AiReviewPayloadInput = z.input<typeof aiReviewPayloadSchema>
