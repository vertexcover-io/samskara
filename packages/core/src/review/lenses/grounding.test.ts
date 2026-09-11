import { describe, expect, test } from "vitest"
import { sessionIndexFrom, validateGrounding } from "./grounding.js"
import type { AiReviewPayload } from "./schema.js"

const seqs = new Set([0, 1, 2, 3, 4, 5, 6, 7])
const messageIds = new Set(["msg-0", "msg-1", "msg-2", "msg-3", "msg-4", "msg-5", "msg-6", "msg-7"])
const tracks = new Set(["main", "agent:sub"])

const index = { seqs, messageIds, tracks }

const parseTimelineEntry = (overrides: Record<string, unknown> = {}) => ({
  id: "exploration",
  kind: "phase",
  title: "Exploring the codebase",
  summary: "The agent read the repo before touching anything.",
  fromSeq: 0,
  toSeq: 4,
  messageIds: ["msg-0", "msg-2"],
  tracks: ["main"],
  ...overrides,
})

/**
 * Cast, not parse: grounding is an independent audit gate, and its tests must reach payloads
 * the schema refinement would reject (non-ascending timelines) without throwing first.
 */
const payloadWith = (
  timelineEntries: Array<Record<string, unknown>>,
  learnings: Array<Record<string, unknown>> = [
    {
      title: "Name the file to touch",
      detail: "The first prompt omitted the path, so the agent guessed wrong.",
      category: "communication",
      audience: "human",
      severity: "medium",
      nextTime: "Open the task by naming the exact file to change.",
      evidence: [{ seq: 2, messageId: "msg-2", what: "the agent guessed the wrong file" }],
    },
  ],
): AiReviewPayload =>
  ({
    analyzer: "ai-v1",
    model: "glm-5.3",
    harness: "opencode",
    outcome: "shipped",
    friction: "moderate",
    summary: "A session that shipped after one mid-course correction.",
    lenses: [
      { lens: "timeline", entries: timelineEntries },
      { lens: "humanLearnings", learnings },
      {
        lens: "agentLearnings",
        learnings: [
          {
            title: "Read the test file first",
            detail: "The tests named the exact convention the edit broke.",
            category: "approach",
            audience: "agent",
            severity: "low",
            nextTime: "Read the covering test before editing the source it guards.",
            evidence: [{ seq: 5, messageId: "msg-5", what: "the failing test run" }],
          },
        ],
      },
      {
        lens: "breadcrumbs",
        learnings: [
          {
            title: "Failed-jobs lookup",
            detail:
              "The psql query lists failed jobs with their last error, so nobody re-derives it.",
            category: "query",
            audience: "agent",
            severity: "low",
            nextTime: "Reach for this before writing a new query against the jobs table.",
            evidence: [{ seq: 1, messageId: "msg-1", what: "the query was worked out here" }],
          },
        ],
      },
    ],
  }) as unknown as AiReviewPayload

describe("validateGrounding", () => {
  test("G1: accepts a payload whose refs all exist", () => {
    const result = validateGrounding(payloadWith([parseTimelineEntry()]), index)
    expect(result).toEqual({ ok: true })
  })

  test("G2: rejects a dangling timeline messageId with a precise path", () => {
    const payload = payloadWith([parseTimelineEntry({ messageIds: ["msg-0", "msg-99"] })])
    const result = validateGrounding(payload, index)
    expect(result).toEqual({
      ok: false,
      problems: [{ path: "lenses[0].entries[0].messageIds[1]", problem: expect.any(String) }],
    })
  })

  test("G3: rejects fromSeq and toSeq endpoints that are not real events", () => {
    const payload = payloadWith([parseTimelineEntry({ fromSeq: 42, toSeq: 7 })])
    const result = validateGrounding(payload, index)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.problems.map((problem) => problem.path)).toEqual([
        "lenses[0].entries[0].fromSeq",
      ])
    }
  })

  test("G4: rejects a toSeq endpoint that is not a real event", () => {
    const payload = payloadWith([parseTimelineEntry({ toSeq: 99 })])
    const result = validateGrounding(payload, index)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.problems.map((problem) => problem.path)).toEqual(["lenses[0].entries[0].toSeq"])
    }
  })

  test("G5: rejects an unknown track with a precise path", () => {
    const payload = payloadWith([parseTimelineEntry({ tracks: ["side-quest"] })])
    const result = validateGrounding(payload, index)
    expect(result).toEqual({
      ok: false,
      problems: [{ path: "lenses[0].entries[0].tracks[0]", problem: expect.any(String) }],
    })
  })

  test("G6: rejects timeline entries whose fromSeq is not strictly ascending", () => {
    const payload = payloadWith([
      parseTimelineEntry({ fromSeq: 2, toSeq: 4, messageIds: ["msg-2"] }),
      parseTimelineEntry({ id: "second", fromSeq: 2, toSeq: 6, messageIds: ["msg-2"] }),
    ])
    const result = validateGrounding(payload, index)
    expect(result).toEqual({
      ok: false,
      problems: [{ path: "lenses[0].entries[1].fromSeq", problem: expect.any(String) }],
    })
  })

  test("G7: rejects learning evidence with a dangling seq or messageId", () => {
    const payload = payloadWith(
      [parseTimelineEntry()],
      [
        {
          title: "Name the file to touch",
          detail: "The first prompt omitted the path, so the agent guessed wrong.",
          category: "communication",
          audience: "human",
          severity: "medium",
          nextTime: "Open the task by naming the exact file to change.",
          evidence: [
            { seq: 2, messageId: "msg-2", what: "grounded" },
            { seq: 55, messageId: "msg-77", what: "not grounded" },
          ],
        },
      ],
    )
    const result = validateGrounding(payload, index)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.problems.map((problem) => problem.path)).toEqual([
        "lenses[1].learnings[0].evidence[1].seq",
        "lenses[1].learnings[0].evidence[1].messageId",
      ])
    }
  })

  test("G10: breadcrumbs citing the transcript are audited like every lens", () => {
    const payload = payloadWith([parseTimelineEntry()])
    // Replace the breadcrumb's evidence with a dangling ref.
    const breadcrumbs = payload.lenses[3]
    if (breadcrumbs === undefined || breadcrumbs.lens !== "breadcrumbs")
      throw new Error("expected breadcrumbs lens")
    const first = breadcrumbs.learnings[0]
    if (first === undefined) throw new Error("expected a breadcrumb")
    first.evidence = [
      { seq: 42, messageId: "msg-42", what: "a harness failure the session never had" },
    ]
    const result = validateGrounding(payload, index)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.problems.map((problem) => problem.path)).toEqual([
        "lenses[3].learnings[0].evidence[0].seq",
        "lenses[3].learnings[0].evidence[0].messageId",
      ])
    }
  })

  test("G11: a breadcrumb with no evidence refs (a nothing-entry) grounds clean", () => {
    const payload = payloadWith([parseTimelineEntry()])
    const breadcrumbs = payload.lenses[3]
    if (breadcrumbs === undefined || breadcrumbs.lens !== "breadcrumbs")
      throw new Error("expected breadcrumbs lens")
    const first = breadcrumbs.learnings[0]
    if (first === undefined) throw new Error("expected a breadcrumb")
    first.evidence = []
    expect(validateGrounding(payload, index)).toEqual({ ok: true })
  })

  test("G8: accumulates every problem across lenses", () => {
    const payload = payloadWith(
      [parseTimelineEntry({ fromSeq: 9, toSeq: 10, messageIds: ["msg-99"], tracks: ["nope"] })],
      [],
    )
    const result = validateGrounding(payload, index)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.problems).toHaveLength(4)
    }
  })

  test("G9: sessionIndexFrom builds the sets from array shape", () => {
    const built = sessionIndexFrom({
      seqs: [0, 1],
      messageIds: ["msg-0", "msg-1"],
      tracks: ["main"],
    })
    expect(built.seqs.has(1)).toBe(true)
    expect(built.messageIds.has("msg-1")).toBe(true)
    expect(built.tracks.has("main")).toBe(true)
    expect(built.seqs.has(2)).toBe(false)
  })
})
