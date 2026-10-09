import { expect, test } from "vitest"
import {
  COMPOUND_LEARNINGS_BATCH_MAX,
  compoundLearningEventSchema,
  pushCompoundLearningsRequestSchema,
} from "./compoundLearnings.js"

const event = {
  event_id: "evt-1",
  session_id: "sess-1",
  timestamp: "2026-10-06T12:00:00Z",
  trigger: "manual",
  why_triggered: "user corrected the same mistake twice",
  proposed_learning: "Use absolute paths in worktrees",
  outcome: "new",
}

test("a minimal event with only the required keys parses, and optional ones stay absent", () => {
  const parsed = compoundLearningEventSchema.parse(event)
  expect(parsed).toEqual(event)
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
    skill_version: "harness@1.33.1",
    evidence_from_message: "0b7e6c1a-4a1e-4c55-9c1e-2f3d5a6b7c8d",
    evidence_to_message: "1c8f7d2b-5b2f-4d66-8d2f-3a4e6b7c8d9e",
    options_shown: ["1. x", "2. y"],
    option_user_picked: "",
    outcome: "occurrence",
    status: "existing",
    final_learning: "final",
    rejection_reason: "",
    learning_file: "docs/learnings.md",
  }
  expect(compoundLearningEventSchema.safeParse(full).success).toBe(true)
})

test("unknown trigger, outcome or status values are rejected", () => {
  expect(compoundLearningEventSchema.safeParse({ ...event, trigger: "cron" }).success).toBe(false)
  expect(compoundLearningEventSchema.safeParse({ ...event, outcome: "maybe" }).success).toBe(false)
  expect(compoundLearningEventSchema.safeParse({ ...event, status: "sure" }).success).toBe(false)
})

test("evidence message ids are each empty or a transcript line uuid", () => {
  const uuid = "0b7e6c1a-4a1e-4c55-9c1e-2f3d5a6b7c8d"
  const ok = (extra: Record<string, unknown>) =>
    compoundLearningEventSchema.safeParse({ ...event, ...extra }).success
  expect(ok({ evidence_from_message: "", evidence_to_message: "" })).toBe(true)
  expect(ok({ evidence_from_message: uuid, evidence_to_message: uuid })).toBe(true)
  expect(ok({ evidence_from_message: "msg-12" })).toBe(false)
  expect(ok({ evidence_to_message: "not-a-uuid" })).toBe(false)
})

test("a missing required key or a non-ISO timestamp is rejected", () => {
  const { event_id: _dropped, ...withoutId } = event
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
    event_id: `evt-${i}`,
  }))
  expect(pushCompoundLearningsRequestSchema.safeParse({ events: tooMany }).success).toBe(false)
})
