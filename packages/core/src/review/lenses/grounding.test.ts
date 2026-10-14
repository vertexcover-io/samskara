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

const HUMAN_LEARNING = {
  title: "Name the file to touch",
  detail: "The first prompt omitted the path, so the agent guessed wrong.",
  category: "communication",
  audience: "human",
  severity: "medium",
  nextTime: "Open the task by naming the exact file to change.",
  evidence: [{ seq: 2, messageId: "msg-2", what: "the agent guessed the wrong file" }],
}

const BREADCRUMB = {
  title: "Failed-jobs lookup",
  detail: "The psql query lists failed jobs with their last error, so nobody re-derives it.",
  category: "query",
  audience: "agent",
  severity: "low",
  nextTime: "Reach for this before writing a new query against the jobs table.",
  evidence: [{ seq: 1, messageId: "msg-1", what: "the query was worked out here" }],
}

/**
 * Cast, not parse: grounding is an independent audit gate, and its tests must reach payloads
 * the schema refinement would reject (non-ascending timelines) without throwing first.
 */
const payloadWith = (
  timelineEntries: Array<Record<string, unknown>>,
  {
    human = [HUMAN_LEARNING],
    breadcrumbs = [BREADCRUMB],
  }: {
    readonly human?: ReadonlyArray<Record<string, unknown>>
    readonly breadcrumbs?: ReadonlyArray<Record<string, unknown>>
  } = {},
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
      { lens: "humanLearnings", learnings: human },
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
      { lens: "breadcrumbs", learnings: breadcrumbs },
    ],
  }) as unknown as AiReviewPayload

describe("validateGrounding", () => {
  test("G1: accepts a payload whose refs all exist", () => {
    const result = validateGrounding(payloadWith([parseTimelineEntry()]), index)
    expect(result).toEqual({ ok: true })
  })

  test.each([
    {
      id: "G2",
      label: "a dangling timeline messageId",
      overrides: { messageIds: ["msg-0", "msg-99"] },
      path: "lenses[0].entries[0].messageIds[1]",
    },
    {
      id: "G3",
      label: "a fromSeq endpoint that is not a real event",
      overrides: { fromSeq: 42, toSeq: 7 },
      path: "lenses[0].entries[0].fromSeq",
    },
    {
      id: "G4",
      label: "a toSeq endpoint that is not a real event",
      overrides: { toSeq: 99 },
      path: "lenses[0].entries[0].toSeq",
    },
    {
      id: "G5",
      label: "an unknown track",
      overrides: { tracks: ["side-quest"] },
      path: "lenses[0].entries[0].tracks[0]",
    },
  ])("$id: rejects $label at its precise path", ({ overrides, path }) => {
    const result = validateGrounding(payloadWith([parseTimelineEntry(overrides)]), index)
    expect(result).toEqual({ ok: false, problems: [{ path, problem: expect.any(String) }] })
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

  type Evidence = { seq: number; messageId: string; what: string }

  const withEvidence = (lens: "human" | "breadcrumbs", evidence: ReadonlyArray<Evidence>) =>
    payloadWith(
      [parseTimelineEntry()],
      lens === "human"
        ? { human: [{ ...HUMAN_LEARNING, evidence }] }
        : { breadcrumbs: [{ ...BREADCRUMB, evidence }] },
    )

  test.each([
    {
      id: "G7",
      label: "learning evidence with a dangling seq and messageId is rejected",
      payload: () =>
        withEvidence("human", [
          { seq: 2, messageId: "msg-2", what: "grounded" },
          { seq: 55, messageId: "msg-77", what: "not grounded" },
        ]),
      paths: [
        "lenses[1].learnings[0].evidence[1].seq",
        "lenses[1].learnings[0].evidence[1].messageId",
      ],
    },
    {
      id: "G10",
      label: "breadcrumb evidence with a dangling seq and messageId is rejected like every lens",
      payload: () =>
        withEvidence("breadcrumbs", [
          { seq: 42, messageId: "msg-42", what: "a harness failure the session never had" },
        ]),
      paths: [
        "lenses[3].learnings[0].evidence[0].seq",
        "lenses[3].learnings[0].evidence[0].messageId",
      ],
    },
  ])("$id: $label", ({ payload, paths }) => {
    const result = validateGrounding(payload(), index)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.problems.map((problem) => problem.path)).toEqual(paths)
  })

  test("G11: a breadcrumb with no evidence refs (a nothing-entry) grounds clean", () => {
    expect(validateGrounding(withEvidence("breadcrumbs", []), index)).toEqual({ ok: true })
  })

  test("G8: accumulates every problem across lenses", () => {
    const payload = payloadWith(
      [parseTimelineEntry({ fromSeq: 9, toSeq: 10, messageIds: ["msg-99"], tracks: ["nope"] })],
      { human: [] },
    )
    const result = validateGrounding(payload, index)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.problems).toHaveLength(4)
    }
  })

  test("G12: a ref whose seq and messageId name different records is rejected", () => {
    // Both halves exist in the export, so two independent membership tests both pass. But
    // the export mints `msg-<seq>`, so this ref describes one record and links to another —
    // exactly the hallucinated-citation class the gate exists to stop.
    const result = validateGrounding(
      withEvidence("human", [{ seq: 3, messageId: "msg-6", what: "mismatched halves" }]),
      index,
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.problems).toContainEqual({
      path: "lenses[1].learnings[0].evidence[0].messageId",
      problem: 'messageId "msg-6" does not belong to seq 3',
    })
  })
})

test("sessionIndexFrom keeps each array of the export's index under its own name", () => {
  expect(sessionIndexFrom({ seqs: [3], messageIds: ["msg-3"], tracks: ["main"] })).toEqual({
    seqs: new Set([3]),
    messageIds: new Set(["msg-3"]),
    tracks: new Set(["main"]),
  })
})
