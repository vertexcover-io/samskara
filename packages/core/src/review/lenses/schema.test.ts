import { describe, expect, test } from "vitest"
import {
  AGENT_LEARNING_CATEGORIES,
  aiReviewPayloadSchema,
  BREADCRUMB_CATEGORIES,
  HUMAN_LEARNING_CATEGORIES,
  LEARNING_SEVERITIES,
  NOTHING_TO_CHANGE_PREFIX,
  reviewCountsSchema,
  TIMELINE_ENTRY_KINDS,
} from "./schema.js"

const timelineEntry = (overrides: Record<string, unknown> = {}) => ({
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

const evidence = (overrides: Record<string, unknown> = {}) => ({
  seq: 2,
  messageId: "msg-2",
  what: "the agent retried the same failing command",
  ...overrides,
})

const humanLearning = (overrides: Record<string, unknown> = {}) => ({
  title: "Name the file to touch",
  detail: "The first prompt omitted the path, so the agent guessed wrong.",
  category: "communication",
  audience: "human",
  severity: "medium",
  nextTime: "Open the task by naming the exact file to change.",
  evidence: [evidence()],
  ...overrides,
})

const agentLearning = (overrides: Record<string, unknown> = {}) => ({
  title: "Read the test file before editing source",
  detail: "The tests named the exact convention the edit broke.",
  category: "approach",
  audience: "agent",
  severity: "low",
  nextTime: "Read the covering test before editing the source it guards.",
  evidence: [evidence({ seq: 5, messageId: "msg-5", what: "the failing test run" })],
  ...overrides,
})

const breadcrumbLearning = (overrides: Record<string, unknown> = {}) => ({
  title: "The psql query that lists failed jobs",
  detail: "The query lists failed jobs with their last error, so nobody re-derives it.",
  category: "query",
  audience: "agent",
  severity: "low",
  nextTime: "Reach for this query before writing a new one against the jobs table.",
  evidence: [evidence({ seq: 1, messageId: "msg-1", what: "the query was worked out here" })],
  ...overrides,
})

const samplePayload = (overrides: Record<string, unknown> = {}) => ({
  analyzer: "ai-v1",
  model: "glm-5.3",
  harness: "opencode",
  outcome: "shipped",
  friction: "moderate",
  summary: "A session that shipped after one mid-course correction.",
  lenses: [
    {
      lens: "timeline",
      entries: [
        timelineEntry(),
        timelineEntry({
          id: "course-correction",
          kind: "turning-point",
          title: "The human redirects the approach",
          summary: "A prompt after two failures switched the strategy.",
          fromSeq: 5,
          toSeq: 6,
          messageIds: ["msg-5"],
        }),
      ],
    },
    { lens: "humanLearnings", learnings: [humanLearning()] },
    { lens: "agentLearnings", learnings: [agentLearning()] },
    { lens: "breadcrumbs", learnings: [breadcrumbLearning()] },
  ],
  ...overrides,
})

const rejects = (value: unknown) =>
  expect(aiReviewPayloadSchema.safeParse(value).success).toBe(false)

describe("aiReviewPayloadSchema", () => {
  test("S1: accepts a fully valid payload", () => {
    const parsed = aiReviewPayloadSchema.parse(samplePayload())
    expect(parsed.analyzer).toBe("ai-v1")
    expect(parsed.lenses).toHaveLength(4)
  })

  test("S2: timeline tracks default to ['main'] when omitted", () => {
    const payload = samplePayload({
      lenses: [
        {
          lens: "timeline",
          entries: [
            {
              id: "exploration",
              kind: "phase",
              title: "Exploring",
              summary: "Reading first.",
              fromSeq: 0,
              toSeq: 2,
              messageIds: ["msg-0"],
            },
          ],
        },
        { lens: "humanLearnings", learnings: [] },
        { lens: "agentLearnings", learnings: [] },
        { lens: "breadcrumbs", learnings: [] },
      ],
    })
    const parsed = aiReviewPayloadSchema.parse(payload)
    const timeline = parsed.lenses.find((lens) => lens.lens === "timeline")
    expect(timeline).toEqual({
      lens: "timeline",
      entries: [
        {
          id: "exploration",
          kind: "phase",
          title: "Exploring",
          summary: "Reading first.",
          fromSeq: 0,
          toSeq: 2,
          messageIds: ["msg-0"],
          tracks: ["main"],
        },
      ],
    })
  })

  test("S3: all three learnings arrays may be empty", () => {
    const payload = samplePayload({
      lenses: [
        samplePayload().lenses[0],
        { lens: "humanLearnings", learnings: [] },
        { lens: "agentLearnings", learnings: [] },
        { lens: "breadcrumbs", learnings: [] },
      ],
    })
    expect(aiReviewPayloadSchema.parse(payload).lenses).toHaveLength(4)
  })

  test("S4: every registered kind, category, severity and audience round-trips", () => {
    const timelineOnly = (entries: Array<Record<string, unknown>>) =>
      samplePayload({
        lenses: [
          { lens: "timeline", entries },
          { lens: "humanLearnings", learnings: [] },
          { lens: "agentLearnings", learnings: [] },
          { lens: "breadcrumbs", learnings: [] },
        ],
      })
    for (const kind of TIMELINE_ENTRY_KINDS) {
      expect(aiReviewPayloadSchema.safeParse(timelineOnly([timelineEntry({ kind })])).success).toBe(
        true,
      )
    }
    const withLearning = (lensName: string, learning: Record<string, unknown>) =>
      samplePayload({
        lenses: [
          { lens: "timeline", entries: [timelineEntry()] },
          lensName === "humanLearnings"
            ? { lens: "humanLearnings", learnings: [learning] }
            : { lens: "humanLearnings", learnings: [] },
          lensName === "agentLearnings"
            ? { lens: "agentLearnings", learnings: [learning] }
            : { lens: "agentLearnings", learnings: [] },
          lensName === "breadcrumbs"
            ? { lens: "breadcrumbs", learnings: [learning] }
            : { lens: "breadcrumbs", learnings: [] },
        ],
      })
    for (const category of HUMAN_LEARNING_CATEGORIES) {
      expect(
        aiReviewPayloadSchema.safeParse(withLearning("humanLearnings", humanLearning({ category })))
          .success,
      ).toBe(true)
    }
    for (const category of AGENT_LEARNING_CATEGORIES) {
      expect(
        aiReviewPayloadSchema.safeParse(withLearning("agentLearnings", agentLearning({ category })))
          .success,
      ).toBe(true)
    }
    for (const category of BREADCRUMB_CATEGORIES) {
      expect(
        aiReviewPayloadSchema.safeParse(
          withLearning("breadcrumbs", breadcrumbLearning({ category })),
        ).success,
      ).toBe(true)
    }
    for (const severity of LEARNING_SEVERITIES) {
      expect(
        aiReviewPayloadSchema.safeParse(withLearning("humanLearnings", humanLearning({ severity })))
          .success,
      ).toBe(true)
    }
  })

  test("S5: rejects an unknown lens discriminator", () => {
    rejects(
      samplePayload({
        lenses: [
          samplePayload().lenses[0],
          { lens: "humanLearnings", learnings: [] },
          { lens: "agentLearnings", learnings: [] },
          { lens: "breadcrumbs", learnings: [] },
          { lens: "vibes", feelings: [] },
        ],
      }),
    )
  })

  test("S6: rejects a missing timeline lens", () => {
    rejects(
      samplePayload({
        lenses: [
          { lens: "humanLearnings", learnings: [] },
          { lens: "agentLearnings", learnings: [] },
          { lens: "breadcrumbs", learnings: [] },
        ],
      }),
    )
  })

  test("S7: rejects a missing or duplicated learnings lens (all three audiences)", () => {
    rejects(
      samplePayload({
        lenses: [
          samplePayload().lenses[0],
          { lens: "agentLearnings", learnings: [] },
          { lens: "breadcrumbs", learnings: [] },
        ],
      }),
    )
    rejects(
      samplePayload({
        lenses: [
          samplePayload().lenses[0],
          { lens: "humanLearnings", learnings: [] },
          { lens: "agentLearnings", learnings: [] },
        ],
      }),
    )
    for (const duplicated of ["humanLearnings", "agentLearnings", "breadcrumbs"] as const) {
      rejects(
        samplePayload({
          lenses: [
            samplePayload().lenses[0],
            { lens: "humanLearnings", learnings: [] },
            { lens: "agentLearnings", learnings: [] },
            { lens: "breadcrumbs", learnings: [] },
            { lens: duplicated, learnings: [] },
          ],
        }),
      )
    }
  })

  test("S8: rejects a duplicated timeline lens", () => {
    rejects(
      samplePayload({
        lenses: [
          samplePayload().lenses[0],
          {
            lens: "timeline",
            entries: [timelineEntry({ id: "again", fromSeq: 9, toSeq: 9, messageIds: ["msg-9"] })],
          },
          { lens: "humanLearnings", learnings: [] },
          { lens: "agentLearnings", learnings: [] },
          { lens: "breadcrumbs", learnings: [] },
        ],
      }),
    )
  })

  test("S9: rejects a category from the wrong audience", () => {
    rejects(
      samplePayload({
        lenses: [
          { lens: "timeline", entries: [timelineEntry()] },
          { lens: "humanLearnings", learnings: [humanLearning({ category: "efficiency" })] },
          { lens: "agentLearnings", learnings: [] },
          { lens: "breadcrumbs", learnings: [] },
        ],
      }),
    )
    rejects(
      samplePayload({
        lenses: [
          { lens: "timeline", entries: [timelineEntry()] },
          { lens: "humanLearnings", learnings: [] },
          { lens: "agentLearnings", learnings: [agentLearning({ category: "tooling" })] },
          { lens: "breadcrumbs", learnings: [] },
        ],
      }),
    )
    rejects(
      samplePayload({
        lenses: [
          { lens: "timeline", entries: [timelineEntry()] },
          { lens: "humanLearnings", learnings: [] },
          { lens: "agentLearnings", learnings: [] },
          { lens: "breadcrumbs", learnings: [breadcrumbLearning({ category: "communication" })] },
        ],
      }),
    )
  })

  test("S10: rejects an audience that does not match the learning's lens", () => {
    rejects(
      samplePayload({
        lenses: [
          { lens: "timeline", entries: [timelineEntry()] },
          { lens: "humanLearnings", learnings: [humanLearning({ audience: "agent" })] },
          { lens: "agentLearnings", learnings: [] },
          { lens: "breadcrumbs", learnings: [] },
        ],
      }),
    )
    rejects(
      samplePayload({
        lenses: [
          { lens: "timeline", entries: [timelineEntry()] },
          { lens: "humanLearnings", learnings: [] },
          { lens: "agentLearnings", learnings: [] },
          { lens: "breadcrumbs", learnings: [breadcrumbLearning({ audience: "human" })] },
        ],
      }),
    )
    rejects(
      samplePayload({
        lenses: [
          { lens: "timeline", entries: [timelineEntry()] },
          {
            lens: "humanLearnings",
            learnings: [humanLearning({ audience: "crowd" })],
          },
          { lens: "agentLearnings", learnings: [] },
          { lens: "breadcrumbs", learnings: [] },
        ],
      }),
    )
  })

  test("S11: rejects an unknown severity; cost is optional but bounded", () => {
    rejects(
      samplePayload({
        lenses: [
          { lens: "timeline", entries: [timelineEntry()] },
          { lens: "humanLearnings", learnings: [humanLearning({ severity: "catastrophic" })] },
          { lens: "agentLearnings", learnings: [] },
          { lens: "breadcrumbs", learnings: [] },
        ],
      }),
    )
    rejects(
      samplePayload({
        lenses: [
          { lens: "timeline", entries: [timelineEntry()] },
          { lens: "humanLearnings", learnings: [humanLearning({ cost: "x".repeat(121) })] },
          { lens: "agentLearnings", learnings: [] },
          { lens: "breadcrumbs", learnings: [] },
        ],
      }),
    )
    const parsed = aiReviewPayloadSchema.parse(
      samplePayload({
        lenses: [
          { lens: "timeline", entries: [timelineEntry()] },
          { lens: "humanLearnings", learnings: [humanLearning({ cost: undefined })] },
          { lens: "agentLearnings", learnings: [] },
          { lens: "breadcrumbs", learnings: [] },
        ],
      }),
    )
    expect(parsed.lenses[1]).toMatchObject({
      lens: "humanLearnings",
      learnings: [expect.not.objectContaining({ cost: expect.anything() })],
    })
  })

  test("S12: nextTime is required unless the title starts with the nothing prefix", () => {
    rejects(
      samplePayload({
        lenses: [
          { lens: "timeline", entries: [timelineEntry()] },
          { lens: "humanLearnings", learnings: [humanLearning({ nextTime: undefined })] },
          { lens: "agentLearnings", learnings: [] },
          { lens: "breadcrumbs", learnings: [] },
        ],
      }),
    )
    rejects(
      samplePayload({
        lenses: [
          { lens: "timeline", entries: [timelineEntry()] },
          { lens: "humanLearnings", learnings: [humanLearning({ nextTime: "   " })] },
          { lens: "agentLearnings", learnings: [] },
          { lens: "breadcrumbs", learnings: [] },
        ],
      }),
    )
    const nothingTitle = `${NOTHING_TO_CHANGE_PREFIX} for the human`
    expect(
      aiReviewPayloadSchema.safeParse(
        samplePayload({
          lenses: [
            { lens: "timeline", entries: [timelineEntry()] },
            {
              lens: "humanLearnings",
              learnings: [
                humanLearning({
                  title: nothingTitle,
                  detail: "The prompts were clear throughout.",
                  nextTime: undefined,
                  evidence: [],
                }),
              ],
            },
            { lens: "agentLearnings", learnings: [] },
            { lens: "breadcrumbs", learnings: [] },
          ],
        }),
      ).success,
    ).toBe(true)
    // An empty nextTime string is also fine on a nothing-entry.
    expect(
      aiReviewPayloadSchema.safeParse(
        samplePayload({
          lenses: [
            { lens: "timeline", entries: [timelineEntry()] },
            {
              lens: "humanLearnings",
              learnings: [humanLearning({ title: nothingTitle, nextTime: "", evidence: [] })],
            },
            { lens: "agentLearnings", learnings: [] },
            { lens: "breadcrumbs", learnings: [] },
          ],
        }),
      ).success,
    ).toBe(true)
  })

  test("S13: rejects evidence-free learnings unless they are nothing-entries", () => {
    rejects(
      samplePayload({
        lenses: [
          { lens: "timeline", entries: [timelineEntry()] },
          { lens: "humanLearnings", learnings: [humanLearning({ evidence: [] })] },
          { lens: "agentLearnings", learnings: [] },
          { lens: "breadcrumbs", learnings: [] },
        ],
      }),
    )
    expect(
      aiReviewPayloadSchema.safeParse(
        samplePayload({
          lenses: [
            { lens: "timeline", entries: [timelineEntry()] },
            {
              lens: "humanLearnings",
              learnings: [
                humanLearning({
                  title: `${NOTHING_TO_CHANGE_PREFIX} for the human`,
                  nextTime: undefined,
                  evidence: [],
                }),
              ],
            },
            { lens: "agentLearnings", learnings: [] },
            { lens: "breadcrumbs", learnings: [] },
          ],
        }),
      ).success,
    ).toBe(true)
  })

  test("S14: accepts an optional partial block and rejects a malformed one", () => {
    const partial = {
      claimed: { timeline: 20, human: 4, agent: 5, breadcrumbs: 2 },
      parsed: { timeline: 8, human: 2, agent: 3, breadcrumbs: 1 },
    }
    const parsed = aiReviewPayloadSchema.parse(samplePayload({ partial }))
    expect(parsed.partial).toEqual(partial)
    rejects(samplePayload({ partial: { claimed: { timeline: 20 } } }))
    rejects(
      samplePayload({
        partial: {
          claimed: { timeline: -1, human: 0, agent: 0, breadcrumbs: 0 },
          parsed: { timeline: 0, human: 0, agent: 0, breadcrumbs: 0 },
        },
      }),
    )
    rejects(samplePayload({ partial: { claimed: null } }))
    expect(
      reviewCountsSchema.safeParse({ timeline: 0, human: 0, agent: 0, breadcrumbs: 0 }).success,
    ).toBe(true)
    expect(reviewCountsSchema.safeParse({ timeline: 0, human: 0, agent: 0 }).success).toBe(false)
  })

  test("S15: rejects over-long fields", () => {
    const withEntry = (entryOverrides: Record<string, unknown>) =>
      samplePayload({
        lenses: [
          { lens: "timeline", entries: [timelineEntry(entryOverrides)] },
          { lens: "humanLearnings", learnings: [] },
          { lens: "agentLearnings", learnings: [] },
          { lens: "breadcrumbs", learnings: [] },
        ],
      })

    rejects(withEntry({ title: "x".repeat(121) }))
    rejects(withEntry({ summary: "x".repeat(601) }))
    rejects(withEntry({ messageIds: [] }))

    rejects(samplePayload({ summary: "x".repeat(601) }))

    const withHuman = (learningOverrides: Record<string, unknown>) =>
      samplePayload({
        lenses: [
          samplePayload().lenses[0],
          { lens: "humanLearnings", learnings: [humanLearning(learningOverrides)] },
          { lens: "agentLearnings", learnings: [] },
          { lens: "breadcrumbs", learnings: [] },
        ],
      })
    rejects(withHuman({ title: "x".repeat(121) }))
    rejects(withHuman({ detail: "x".repeat(601) }))
    rejects(withHuman({ nextTime: "x".repeat(301) }))
    rejects(withHuman({ evidence: [{ seq: 1, messageId: "msg-1", what: "x".repeat(201) }] }))
  })

  test("S16: rejects non-strict extra keys at every level", () => {
    rejects(samplePayload({ temperature: 0.2 }))
    rejects(samplePayload({ lenses: [{ lens: "timeline", entries: [], extra: 1 }] }))
    rejects(
      samplePayload({
        lenses: [
          { lens: "timeline", entries: [timelineEntry({ confidence: 0.9 })] },
          { lens: "humanLearnings", learnings: [] },
          { lens: "agentLearnings", learnings: [] },
          { lens: "breadcrumbs", learnings: [] },
        ],
      }),
    )
    rejects(
      samplePayload({
        lenses: [
          samplePayload().lenses[0],
          { lens: "humanLearnings", learnings: [humanLearning({ vibe: "off" })] },
          { lens: "agentLearnings", learnings: [] },
          { lens: "breadcrumbs", learnings: [] },
        ],
      }),
    )
  })

  test("S17: rejects an unknown outcome, friction or analyzer", () => {
    rejects(samplePayload({ outcome: "vibes" }))
    rejects(samplePayload({ friction: "some" }))
    rejects(samplePayload({ analyzer: "ai-v2" }))
  })

  test("S18: rejects toSeq below fromSeq", () => {
    rejects(
      samplePayload({
        lenses: [
          { lens: "timeline", entries: [timelineEntry({ fromSeq: 4, toSeq: 3 })] },
          { lens: "humanLearnings", learnings: [] },
          { lens: "agentLearnings", learnings: [] },
          { lens: "breadcrumbs", learnings: [] },
        ],
      }),
    )
  })

  test("S19: rejects timeline entries whose fromSeq is not strictly ascending", () => {
    rejects(
      samplePayload({
        lenses: [
          {
            lens: "timeline",
            entries: [
              timelineEntry({ fromSeq: 2, toSeq: 4 }),
              timelineEntry({ id: "second", fromSeq: 2, toSeq: 6, messageIds: ["msg-2"] }),
            ],
          },
          { lens: "humanLearnings", learnings: [] },
          { lens: "agentLearnings", learnings: [] },
          { lens: "breadcrumbs", learnings: [] },
        ],
      }),
    )
    rejects(
      samplePayload({
        lenses: [
          {
            lens: "timeline",
            entries: [
              timelineEntry({ fromSeq: 5, toSeq: 6 }),
              timelineEntry({ id: "second", fromSeq: 4, toSeq: 6, messageIds: ["msg-4"] }),
            ],
          },
          { lens: "humanLearnings", learnings: [] },
          { lens: "agentLearnings", learnings: [] },
          { lens: "breadcrumbs", learnings: [] },
        ],
      }),
    )
  })

  test("S20: rejects duplicate timeline entry ids and non-slug ids", () => {
    rejects(
      samplePayload({
        lenses: [
          {
            lens: "timeline",
            entries: [
              timelineEntry({ fromSeq: 0, toSeq: 2, messageIds: ["msg-0"] }),
              timelineEntry({ fromSeq: 3, toSeq: 4, messageIds: ["msg-3"] }),
            ],
          },
          { lens: "humanLearnings", learnings: [] },
          { lens: "agentLearnings", learnings: [] },
          { lens: "breadcrumbs", learnings: [] },
        ],
      }),
    )
    rejects(
      samplePayload({
        lenses: [
          { lens: "timeline", entries: [timelineEntry({ id: "Not A Slug" })] },
          { lens: "humanLearnings", learnings: [] },
          { lens: "agentLearnings", learnings: [] },
          { lens: "breadcrumbs", learnings: [] },
        ],
      }),
    )
  })

  test("S21: rejects an empty timeline, negative seqs and non-integer seqs", () => {
    rejects(
      samplePayload({
        lenses: [
          { lens: "timeline", entries: [] },
          { lens: "humanLearnings", learnings: [] },
          { lens: "agentLearnings", learnings: [] },
          { lens: "breadcrumbs", learnings: [] },
        ],
      }),
    )
    rejects(
      samplePayload({
        lenses: [
          { lens: "timeline", entries: [timelineEntry({ fromSeq: -1, toSeq: 2 })] },
          { lens: "humanLearnings", learnings: [] },
          { lens: "agentLearnings", learnings: [] },
          { lens: "breadcrumbs", learnings: [] },
        ],
      }),
    )
    rejects(
      samplePayload({
        lenses: [
          { lens: "timeline", entries: [timelineEntry({ fromSeq: 0.5, toSeq: 2 })] },
          { lens: "humanLearnings", learnings: [] },
          { lens: "agentLearnings", learnings: [] },
          { lens: "breadcrumbs", learnings: [] },
        ],
      }),
    )
  })
})
