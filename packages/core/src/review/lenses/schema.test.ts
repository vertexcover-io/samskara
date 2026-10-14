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

type Row = Record<string, unknown>

const withLenses = ({
  entries = [timelineEntry()],
  human = [],
  agent = [],
  breadcrumbs = [],
}: {
  entries?: Row[]
  human?: Row[]
  agent?: Row[]
  breadcrumbs?: Row[]
}) =>
  samplePayload({
    lenses: [
      { lens: "timeline", entries },
      { lens: "humanLearnings", learnings: human },
      { lens: "agentLearnings", learnings: agent },
      { lens: "breadcrumbs", learnings: breadcrumbs },
    ],
  })

describe("aiReviewPayloadSchema", () => {
  test("S1: accepts a fully valid payload", () => {
    const parsed = aiReviewPayloadSchema.parse(samplePayload())
    expect(parsed.analyzer).toBe("ai-v1")
    expect(parsed.lenses).toHaveLength(4)
  })

  test("S2: timeline tracks default to empty — the pipeline derives them from the seq range", () => {
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
          tracks: [],
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

  // parseReviewXml checks values against these constants, then validates with this schema; the two
  // lists drifting apart would make every review using the dropped value fail validation.
  test.each([
    ...TIMELINE_ENTRY_KINDS.map((kind) => [
      `kind ${kind}`,
      withLenses({ entries: [timelineEntry({ kind })] }),
    ]),
    ...HUMAN_LEARNING_CATEGORIES.map((category) => [
      `human category ${category}`,
      withLenses({ human: [humanLearning({ category })] }),
    ]),
    ...AGENT_LEARNING_CATEGORIES.map((category) => [
      `agent category ${category}`,
      withLenses({ agent: [agentLearning({ category })] }),
    ]),
    ...BREADCRUMB_CATEGORIES.map((category) => [
      `breadcrumb category ${category}`,
      withLenses({ breadcrumbs: [breadcrumbLearning({ category })] }),
    ]),
    ...LEARNING_SEVERITIES.map((severity) => [
      `severity ${severity}`,
      withLenses({ human: [humanLearning({ severity })] }),
    ]),
  ])("S4: the schema accepts every value the parser accepts: %s", (_value, payload) => {
    expect(aiReviewPayloadSchema.safeParse(payload).success).toBe(true)
  })

  const human = { lens: "humanLearnings", learnings: [] }
  const agent = { lens: "agentLearnings", learnings: [] }
  const crumbs = { lens: "breadcrumbs", learnings: [] }

  test.each([
    { id: "S6", label: "a missing timeline lens", lenses: [human, agent, crumbs] },
    {
      id: "S7a",
      label: "a missing humanLearnings lens",
      lenses: [samplePayload().lenses[0], agent, crumbs],
    },
    {
      id: "S7b",
      label: "a missing breadcrumbs lens",
      lenses: [samplePayload().lenses[0], human, agent],
    },
    {
      id: "S7c",
      label: "a duplicated humanLearnings lens",
      lenses: [samplePayload().lenses[0], human, agent, crumbs, human],
    },
    {
      id: "S7d",
      label: "a duplicated agentLearnings lens",
      lenses: [samplePayload().lenses[0], human, agent, crumbs, agent],
    },
    {
      id: "S7e",
      label: "a duplicated breadcrumbs lens",
      lenses: [samplePayload().lenses[0], human, agent, crumbs, crumbs],
    },
    {
      id: "S8",
      label: "a duplicated timeline lens",
      lenses: [
        samplePayload().lenses[0],
        {
          lens: "timeline",
          entries: [timelineEntry({ id: "again", fromSeq: 9, toSeq: 9, messageIds: ["msg-9"] })],
        },
        human,
        agent,
        crumbs,
      ],
    },
  ])("$id: rejects $label", ({ lenses }) => {
    rejects(samplePayload({ lenses }))
  })

  test.each([
    {
      id: "S9a",
      label: "a human learning with an agent category",
      payload: withLenses({ human: [humanLearning({ category: "efficiency" })] }),
    },
    {
      id: "S9b",
      label: "an agent learning with a human category",
      payload: withLenses({ agent: [agentLearning({ category: "tooling" })] }),
    },
    {
      id: "S9c",
      label: "a breadcrumb with a human category",
      payload: withLenses({ breadcrumbs: [breadcrumbLearning({ category: "communication" })] }),
    },
    {
      id: "S10a",
      label: "a human learning addressed to the agent",
      payload: withLenses({ human: [humanLearning({ audience: "agent" })] }),
    },
    {
      id: "S10b",
      label: "a breadcrumb addressed to the human",
      payload: withLenses({ breadcrumbs: [breadcrumbLearning({ audience: "human" })] }),
    },
    {
      id: "S10c",
      label: "an unknown audience",
      payload: withLenses({ human: [humanLearning({ audience: "crowd" })] }),
    },
    {
      id: "S11a",
      label: "an unknown severity",
      payload: withLenses({ human: [humanLearning({ severity: "catastrophic" })] }),
    },
    {
      id: "S11b",
      label: "a cost over 120 chars",
      payload: withLenses({ human: [humanLearning({ cost: "x".repeat(121) })] }),
    },
  ])("$id: rejects $label", ({ payload }) => {
    rejects(payload)
  })

  test("S11c: cost is optional", () => {
    const parsed = aiReviewPayloadSchema.parse(
      withLenses({ human: [humanLearning({ cost: undefined })] }),
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

  test.each([
    { id: "S18", label: "toSeq below fromSeq", entries: [timelineEntry({ fromSeq: 4, toSeq: 3 })] },
    {
      id: "S19a",
      label: "a repeated fromSeq",
      entries: [
        timelineEntry({ fromSeq: 2, toSeq: 4 }),
        timelineEntry({ id: "second", fromSeq: 2, toSeq: 6, messageIds: ["msg-2"] }),
      ],
    },
    {
      id: "S19b",
      label: "a descending fromSeq",
      entries: [
        timelineEntry({ fromSeq: 5, toSeq: 6 }),
        timelineEntry({ id: "second", fromSeq: 4, toSeq: 6, messageIds: ["msg-4"] }),
      ],
    },
    {
      id: "S20a",
      label: "duplicate entry ids",
      entries: [
        timelineEntry({ fromSeq: 0, toSeq: 2, messageIds: ["msg-0"] }),
        timelineEntry({ fromSeq: 3, toSeq: 4, messageIds: ["msg-3"] }),
      ],
    },
    { id: "S20b", label: "a non-slug id", entries: [timelineEntry({ id: "Not A Slug" })] },
    { id: "S21a", label: "an empty timeline", entries: [] },
    { id: "S21b", label: "a negative seq", entries: [timelineEntry({ fromSeq: -1, toSeq: 2 })] },
    {
      id: "S21c",
      label: "a non-integer seq",
      entries: [timelineEntry({ fromSeq: 0.5, toSeq: 2 })],
    },
  ])("$id: rejects a timeline with $label", ({ entries }) => {
    rejects(withLenses({ entries }))
  })
})
