import { expect, test } from "vitest"
import {
  COMPOUND_LEARNING_EVENT_ID_MAX,
  COMPOUND_LEARNINGS_BATCH_MAX,
  compoundLearningEventSchema,
  pushCompoundLearningsRequestSchema,
} from "./compoundLearnings.js"

const event = {
  eventId: "evt-1",
  sessionId: "sess-1",
  timestamp: "2026-10-06T12:00:00Z",
  trigger: "manual",
  whyTriggered: "user corrected the same mistake twice",
  proposedLearning: "Use absolute paths in worktrees",
  outcome: "new",
}

test("a minimal event with only the required keys parses, and optional ones stay absent", () => {
  const parsed = compoundLearningEventSchema.parse(event)
  expect(parsed).toEqual(event)
})

test("a snake_case line, as harness and older yok write, parses to the same camelCase event", () => {
  const snake = {
    event_id: "evt-1",
    session_id: "sess-1",
    timestamp: "2026-10-06T12:00:00Z",
    trigger: "manual",
    why_triggered: "user corrected the same mistake twice",
    proposed_learning: "Use absolute paths in worktrees",
    outcome: "new",
    learning_file: "docs/learnings/x.md",
  }
  expect(compoundLearningEventSchema.parse(snake)).toEqual({
    ...event,
    learningFile: "docs/learnings/x.md",
  })
})

test("replaces carries the path of the learning file a new one superseded", () => {
  const superseding = { ...event, replaces: "docs/learnings/old-rule.md" }
  expect(compoundLearningEventSchema.parse(superseding).replaces).toBe("docs/learnings/old-rule.md")
  expect(compoundLearningEventSchema.safeParse({ ...event, outcome: "replaced" }).success).toBe(
    false,
  )
})

test("a full event parses, including the existing status of an occurrence", () => {
  const full = {
    ...event,
    cwd: "/repo",
    skillVersion: "harness@1.33.1",
    evidenceFromMessage: "0b7e6c1a-4a1e-4c55-9c1e-2f3d5a6b7c8d",
    evidenceToMessage: "1c8f7d2b-5b2f-4d66-8d2f-3a4e6b7c8d9e",
    optionsShown: ["1. x", "2. y"],
    optionUserPicked: "",
    outcome: "occurrence",
    status: "existing",
    finalLearning: "final",
    rejectionReason: "",
    learningFile: "docs/learnings.md",
  }
  expect(compoundLearningEventSchema.safeParse(full).success).toBe(true)
})

test("unknown trigger, outcome or status values are rejected", () => {
  expect(compoundLearningEventSchema.safeParse({ ...event, trigger: "cron" }).success).toBe(false)
  expect(compoundLearningEventSchema.safeParse({ ...event, outcome: "maybe" }).success).toBe(false)
  expect(compoundLearningEventSchema.safeParse({ ...event, status: "sure" }).success).toBe(false)
})

test("evidence message ids are each null or a transcript line uuid", () => {
  const uuid = "0b7e6c1a-4a1e-4c55-9c1e-2f3d5a6b7c8d"
  const ok = (extra: Record<string, unknown>) =>
    compoundLearningEventSchema.safeParse({ ...event, ...extra }).success
  expect(ok({ evidenceFromMessage: null, evidenceToMessage: null })).toBe(true)
  expect(ok({ evidenceFromMessage: uuid, evidenceToMessage: uuid })).toBe(true)
  expect(ok({ evidenceFromMessage: "msg-12" })).toBe(false)
  expect(ok({ evidenceToMessage: "not-a-uuid" })).toBe(false)
})

test('an optional field the skill wrote as "" reads as null, so nothing past the file sees ""', () => {
  const parsed = compoundLearningEventSchema.parse({
    ...event,
    cwd: "",
    skillVersion: "",
    evidenceFromMessage: "",
    evidenceToMessage: "",
    optionUserPicked: "",
    status: "",
    finalLearning: "",
    rejectionReason: "",
    learningFile: "",
    replaces: "",
  })
  expect(parsed).toMatchObject({
    cwd: null,
    skillVersion: null,
    evidenceFromMessage: null,
    evidenceToMessage: null,
    optionUserPicked: null,
    status: null,
    finalLearning: null,
    rejectionReason: null,
    learningFile: null,
    replaces: null,
  })
})

test("an event id longer than the table can index is rejected", () => {
  const withId = (eventId: string) =>
    compoundLearningEventSchema.safeParse({ ...event, eventId }).success
  expect(withId("e".repeat(COMPOUND_LEARNING_EVENT_ID_MAX))).toBe(true)
  expect(withId("e".repeat(COMPOUND_LEARNING_EVENT_ID_MAX + 1))).toBe(false)
})

test("a missing required key or a non-ISO timestamp is rejected", () => {
  const { eventId: _dropped, ...withoutId } = event
  expect(compoundLearningEventSchema.safeParse(withoutId).success).toBe(false)
  expect(compoundLearningEventSchema.safeParse({ ...event, timestamp: "yesterday" }).success).toBe(
    false,
  )
})

test("the push request needs between one and the batch cap of events", () => {
  expect(pushCompoundLearningsRequestSchema.safeParse({ events: [] }).success).toBe(false)
  expect(pushCompoundLearningsRequestSchema.safeParse({ events: [event] }).success).toBe(true)
  const tooMany = Array.from({ length: COMPOUND_LEARNINGS_BATCH_MAX + 1 }, (_, i) => ({
    ...event,
    eventId: `evt-${i}`,
  }))
  expect(pushCompoundLearningsRequestSchema.safeParse({ events: tooMany }).success).toBe(false)
})
