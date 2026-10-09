import type {
  CompoundLearningEvent,
  LearnOutcome,
  LearnStatus,
  LearnTrigger,
  PushCompoundLearningsResponse,
} from "@samskara/core"
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  lte,
  max,
  min,
  or,
  type SQL,
  sql,
} from "drizzle-orm"
import type { Querier } from "../db/client.js"
import { compoundLearnings, messages, projects, sessions, users } from "../db/schema.js"
import { visibleToUser } from "./projects.repo.js"

// The skill writes "" for a field that does not apply; the table stores null.
const orNull = <T extends string>(value: T | "" | undefined): T | null =>
  value === undefined || value === "" ? null : value

const toRow = (userId: string, event: CompoundLearningEvent) => ({
  userId,
  eventId: event.event_id,
  sessionId: event.session_id,
  occurredAt: new Date(event.timestamp),
  cwd: orNull(event.cwd),
  trigger: event.trigger,
  whyTriggered: event.why_triggered,
  evidenceFromMessage: orNull(event.evidence_from_message),
  evidenceToMessage: orNull(event.evidence_to_message),
  skillVersion: orNull(event.skill_version),
  optionsShown: event.options_shown ?? null,
  proposedLearning: event.proposed_learning,
  optionUserPicked: orNull(event.option_user_picked),
  outcome: event.outcome,
  status: orNull(event.status),
  finalLearning: orNull(event.final_learning),
  rejectionReason: orNull(event.rejection_reason),
  learningFile: orNull(event.learning_file),
  replaces: orNull(event.replaces),
})

/**
 * An eventId this user already stored -- by an earlier upload of the same file, or earlier in this same
 * batch -- is skipped rather than updated: an event is a fact about the past, so the first copy
 * is never worse than a later one.
 */
export const recordEvents = async (
  db: Querier,
  userId: string,
  events: ReadonlyArray<CompoundLearningEvent>,
): Promise<PushCompoundLearningsResponse> => {
  if (events.length === 0) return { inserted: 0, skipped: 0 }
  const inserted = await db
    .insert(compoundLearnings)
    .values(events.map((event) => toRow(userId, event)))
    .onConflictDoNothing({ target: [compoundLearnings.userId, compoundLearnings.eventId] })
    .returning({ id: compoundLearnings.id })
  return { inserted: inserted.length, skipped: events.length - inserted.length }
}

export type CompoundLearningFilter = {
  readonly outcome?: LearnOutcome
  readonly status?: LearnStatus
  readonly trigger?: LearnTrigger
  readonly skillVersion?: string
}

/** Transcript lines included either side of the evidence, so the exchange reads in context. */
const EVIDENCE_CONTEXT_LINES = 2
/** A wrong id from the skill can span a whole session; the full session page shows the rest. */
const EVIDENCE_MAX_MESSAGES = 100
const LIST_LIMIT = 200

/**
 * An event names a session only if the uploader owns it, so nobody can point an event at a
 * session they cannot read. The uploader always sees their own events; anyone else sees one once
 * its session is ingested into a project they can open. The session's project, and its messages,
 * are shown only to whoever can open that project, uploader included: being removed from a
 * project hides its transcript here too.
 */
const visibleEvents = (db: Querier, userId: string, condition?: SQL) => {
  const projectVisible = and(isNotNull(projects.id), visibleToUser(db, userId))
  return db
    .select({
      event: compoundLearnings,
      userLogin: users.githubLogin,
      projectVisible: sql<boolean>`coalesce(${projectVisible}, false)`,
      projectId: sql<string | null>`case when ${projectVisible} then ${projects.id} end`,
      projectName: sql<string | null>`case when ${projectVisible} then ${projects.name} end`,
    })
    .from(compoundLearnings)
    .innerJoin(users, eq(users.id, compoundLearnings.userId))
    .leftJoin(
      sessions,
      and(
        eq(sessions.id, compoundLearnings.sessionId),
        eq(sessions.userId, compoundLearnings.userId),
      ),
    )
    .leftJoin(projects, eq(projects.id, sessions.projectId))
    .where(and(condition, or(eq(compoundLearnings.userId, userId), projectVisible)))
}

export const listCompoundLearnings = (
  db: Querier,
  userId: string,
  filter: CompoundLearningFilter = {},
) =>
  visibleEvents(
    db,
    userId,
    and(
      filter.outcome === undefined ? undefined : eq(compoundLearnings.outcome, filter.outcome),
      filter.status === undefined ? undefined : eq(compoundLearnings.status, filter.status),
      filter.trigger === undefined ? undefined : eq(compoundLearnings.trigger, filter.trigger),
      filter.skillVersion === undefined
        ? undefined
        : eq(compoundLearnings.skillVersion, filter.skillVersion),
    ),
  )
    .orderBy(desc(compoundLearnings.occurredAt))
    .limit(LIST_LIMIT)

/** First and last main-thread line of the evidence messages that are in the session. */
const evidenceRange = async (db: Querier, sessionId: string, lineUuids: ReadonlyArray<string>) => {
  if (lineUuids.length === 0) return null
  const [row] = await db
    .select({ first: min(messages.lineNumber), last: max(messages.lineNumber) })
    .from(messages)
    .where(
      and(
        eq(messages.sessionId, sessionId),
        eq(messages.isSubagent, false),
        inArray(messages.lineUuid, [...lineUuids]),
      ),
    )
  return row?.first == null || row.last == null ? null : { first: row.first, last: row.last }
}

/**
 * The event, the line range of its evidence, and the main-thread messages in that range with a
 * little context, at most EVIDENCE_MAX_MESSAGES of them (`truncated` says the rest is only on the
 * session page). Null when the event is not visible; no messages when the ids are missing, the
 * transcript has not arrived, or the viewer cannot open the session's project.
 */
export const findCompoundLearning = async (db: Querier, userId: string, id: string) => {
  const [row] = await visibleEvents(db, userId, eq(compoundLearnings.id, id))
  if (row === undefined) return null
  const { sessionId, evidenceFromMessage, evidenceToMessage } = row.event
  const ids = [evidenceFromMessage, evidenceToMessage].filter((value) => value !== null)
  const range = row.projectVisible ? await evidenceRange(db, sessionId, ids) : null
  if (range === null) return { ...row, evidenceRange: null, evidence: [], truncated: false }
  const evidence = await db
    .select({
      id: messages.id,
      lineNumber: messages.lineNumber,
      role: messages.role,
      msgType: messages.msgType,
      content: messages.content,
    })
    .from(messages)
    .where(
      and(
        eq(messages.sessionId, sessionId),
        eq(messages.isSubagent, false),
        gte(messages.lineNumber, range.first - EVIDENCE_CONTEXT_LINES),
        lte(messages.lineNumber, range.last + EVIDENCE_CONTEXT_LINES),
      ),
    )
    .orderBy(asc(messages.lineNumber), asc(messages.subIndex))
    .limit(EVIDENCE_MAX_MESSAGES + 1)
  return {
    ...row,
    evidenceRange: range,
    evidence: evidence.slice(0, EVIDENCE_MAX_MESSAGES),
    truncated: evidence.length > EVIDENCE_MAX_MESSAGES,
  }
}
