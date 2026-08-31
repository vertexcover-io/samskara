import { describe, expect, test, vi } from "vitest"
import { type AiReviewResponse, type ReviewResponse, reviewCommand, reviewOne } from "./review.js"

const okBody = (overrides: Partial<ReviewResponse["review"]> = {}): ReviewResponse => ({
  reviewId: "rev-1",
  review: {
    sessionId: "s-1",
    analyzer: "heuristic-v1",
    analyzedAt: "2026-08-25T12:00:00Z",
    outcome: "struggled",
    friction: "high",
    summary: "struggled: 1 turn, 3 tool calls, 3 failures, high friction, 0 commits",
    signals: {
      turns: 1,
      toolCalls: 3,
      toolFailures: 3,
      errorLoops: [{ toolName: "Bash", consecutiveFailures: 3 }],
    },
    agentLearnings: [{ title: "Bash failed 3 times in a row" }],
    humanFeedback: [
      {
        title: "1 prompt arrived while errors were piling up",
        detail: "State failure handling in the first prompt.",
      },
    ],
    ...overrides,
  },
})

const depsWith = (fetchImpl: typeof fetch, out: string[] = []) => ({
  apiBase: "http://api.test",
  token: "tok",
  fetch: fetchImpl,
  stdout: {
    write: (line: string) => {
      out.push(line)
    },
  },
})

const jsonRes = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status })

describe("reviewOne", () => {
  test("RV1: prints summary, outcome explanation, human feedback and agent learning titles", async () => {
    const out: string[] = []
    const deps = depsWith(
      vi.fn(async () => jsonRes(201, okBody())),
      out,
    )
    const result = await reviewOne("s-1", deps)
    expect(result.ok).toBe(true)
    const text = out.join("")
    expect(text).toContain("struggled: 1 turn, 3 tool calls, 3 failures, high friction, 0 commits")
    expect(text).toContain("What you could have done better")
    expect(text).toContain("1 prompt arrived while errors were piling up")
    expect(text).toContain("Learnings for agents")
    expect(text).toContain("Bash failed 3 times in a row")
  })

  test("RV2: a 404 answers a plain message, not a stack trace", async () => {
    const out: string[] = []
    const deps = depsWith(
      vi.fn(async () => new Response("{}", { status: 404 })),
      out,
    )
    const result = await reviewOne("gone", deps)
    expect(result.ok).toBe(false)
    expect(result.message).toContain("No session gone")
  })

  test("RV3: a session with no learnings prints neither section", async () => {
    const out: string[] = []
    const deps = depsWith(
      vi.fn(async () =>
        jsonRes(201, okBody({ agentLearnings: [], humanFeedback: [], outcome: "productive" })),
      ),
      out,
    )
    await reviewOne("s-1", deps)
    const text = out.join("")
    expect(text).not.toContain("What you could have done better")
    expect(text).not.toContain("Learnings for agents")
  })
})

describe("reviewCommand", () => {
  test("RV4: without a session id it reviews the most recent session", async () => {
    const out: string[] = []
    const fetchMock = vi
      .fn()
      // The server honors limit=1; the mock must too, or the command reviews both.
      .mockResolvedValueOnce(jsonRes(200, { sessions: [{ id: "latest" }] }))
      .mockResolvedValueOnce(jsonRes(201, okBody({ sessionId: "latest" })))
    const code = await reviewCommand(undefined, {
      apiBase: "http://api.test",
      token: "tok",
      fetch: fetchMock as unknown as typeof fetch,
      stdout: { write: (l: string) => out.push(l) },
    })
    expect(code).toBe(0)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[0]?.[0]).toContain("sort=recent&limit=1")
    expect(out.join("")).toContain("Session latest")
  })

  test("RV5: --recent 3 reviews three sessions and fails soft on one refusal", async () => {
    const out: string[] = []
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonRes(200, { sessions: [{ id: "a" }, { id: "b" }, { id: "c" }] }))
      .mockResolvedValueOnce(jsonRes(201, okBody({ sessionId: "a" })))
      .mockResolvedValueOnce(new Response("{}", { status: 500 }))
      .mockResolvedValueOnce(jsonRes(201, okBody({ sessionId: "c" })))
    const code = await reviewCommand(undefined, {
      recent: 3,
      apiBase: "http://api.test",
      token: "tok",
      fetch: fetchMock as unknown as typeof fetch,
      stdout: { write: (l: string) => out.push(l) },
    })
    expect(code).toBe(1)
    expect(out.join("")).toContain("Session a")
    expect(out.join("")).toContain("Session c")
  })

  test("RV6: no token exits 1 with a pairing hint", async () => {
    const out: string[] = []
    const code = await reviewCommand("s-1", {
      apiBase: "http://api.test",
      token: null,
      fetch: vi.fn(),
      stdout: { write: (l: string) => out.push(l) },
    })
    expect(code).toBe(1)
    expect(out.join("")).toContain("samskara login")
  })

  test("RV7: unreachable server exits 1 with the reachable-again message", async () => {
    const out: string[] = []
    const fetchMock = vi.fn().mockRejectedValue(new Error("net down"))
    const code = await reviewCommand(undefined, {
      apiBase: "http://api.test",
      token: "tok",
      fetch: fetchMock as unknown as typeof fetch,
      stdout: { write: (l: string) => out.push(l) },
    })
    expect(code).toBe(1)
    expect(out.join("")).toContain("Could not reach")
  })
})

const aiBody = (overrides: Partial<AiReviewResponse["review"]> = {}): AiReviewResponse => ({
  review: {
    id: "rev-ai-1",
    createdAt: "2026-08-26T09:00:00Z",
    outcome: "shipped",
    friction: "moderate",
    summary: "The migration landed after one false start.",
    signals: {
      model: "glm-5.3",
      harness: "opencode",
      lenses: [
        {
          lens: "timeline",
          entries: [
            {
              id: "scaffold",
              kind: "phase",
              title: "Scaffold the migration",
              summary: "Read the schema and wrote the drizzle migration.",
              fromSeq: 1,
              toSeq: 4,
              messageIds: ["msg-1", "msg-2", "msg-3"],
              tracks: ["main"],
            },
          ],
        },
        {
          lens: "humanLearnings",
          learnings: [
            {
              title: "State the constraint up front",
              detail: "The first prompt omitted the unique constraint.",
              category: "communication",
              audience: "human",
              severity: "medium",
              nextTime: "Name unique constraints in the first prompt.",
              evidence: [{ seq: 1, messageId: "msg-1", what: "prompt without constraints" }],
            },
          ],
        },
        {
          lens: "agentLearnings",
          learnings: [
            {
              title: "Reuse the existing helper",
              detail: "The migration was hand-written against a helper core already ships.",
              category: "efficiency",
              audience: "agent",
              severity: "low",
              nextTime: "Search for an existing helper before hand-rolling SQL.",
              evidence: [{ seq: 3, messageId: "msg-3", what: "hand-rolled SQL" }],
            },
          ],
        },
      ],
    },
    ...overrides,
  },
})

/** AI paths inject sleep too, so a poll loop never waits on real time in a test. */
const aiDepsWith = (fetchImpl: typeof fetch, out: string[] = [], err: string[] = []) => ({
  apiBase: "http://api.test",
  token: "tok",
  fetch: fetchImpl,
  stdout: { write: (l: string) => out.push(l) },
  stderr: { write: (l: string) => err.push(l) },
  sleep: async (_ms: number) => {},
})

const noAiReview = (): Response => jsonRes(404, { error: "noAiReview" })

describe("reviewCommand --ai", () => {
  test("RV8: analyzes, polls past two noAiReview 404s and prints the AI verdict", async () => {
    const out: string[] = []
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonRes(202, { jobId: "job-9" }))
      .mockResolvedValueOnce(noAiReview())
      .mockResolvedValueOnce(noAiReview())
      .mockResolvedValueOnce(jsonRes(200, aiBody()))
    const sleeps: number[] = []
    const code = await reviewCommand("s-1", {
      ai: true,
      ...aiDepsWith(fetchMock as unknown as typeof fetch, out),
      sleep: async (ms: number) => {
        sleeps.push(ms)
      },
    })
    expect(code).toBe(0)
    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/api/sessions/s-1/analyze")
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("/api/sessions/s-1/aireview")
    expect(sleeps).toEqual([3000, 3000])
    const text = out.join("")
    expect(text).toContain("Session s-1")
    expect(text).toContain("shipped — work landed (commit or PR)")
    expect(text).toContain("friction: moderate")
    expect(text).toContain("glm-5.3 via opencode")
    expect(text).toContain("The migration landed after one false start.")
    expect(text).toContain("[phase] Scaffold the migration (seq 1-4, 3 messages)")
    expect(text).toContain(
      "FOR HUMANS [communication] State the constraint up front — The first prompt omitted the unique constraint.",
    )
    expect(text).toContain(
      "FOR AGENTS [efficiency] Reuse the existing helper — The migration was hand-written against a helper core already ships.",
    )
  })

  test("RV9: a poll timeout names the jobId on stderr and keeps stdout quiet", async () => {
    const out: string[] = []
    const err: string[] = []
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonRes(202, { jobId: "job-7" }))
      .mockImplementation(async () => noAiReview())
    const code = await reviewCommand("s-1", {
      ai: true,
      timeoutMs: 0,
      ...aiDepsWith(fetchMock as unknown as typeof fetch, out, err),
    })
    expect(code).toBe(1)
    expect(out.join("")).toBe("")
    expect(err.join("")).toContain("job-7")
    expect(err.join("")).toContain("may still finish server-side")
  })

  test("RV10: a 503 busy explains the analysis cap and exits 1 without polling", async () => {
    const out: string[] = []
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonRes(503, { error: "busy" }))
    const code = await reviewCommand("s-1", {
      ai: true,
      ...aiDepsWith(fetchMock as unknown as typeof fetch, out),
    })
    expect(code).toBe(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(out.join("")).toContain("4 analyses")
    expect(out.join("")).toContain("retry shortly")
  })

  test("RV11: a 403 hints at project edit rights and exits 1", async () => {
    const out: string[] = []
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonRes(403, { error: "notEditable" }))
    const code = await reviewCommand("s-1", {
      ai: true,
      ...aiDepsWith(fetchMock as unknown as typeof fetch, out),
    })
    expect(code).toBe(1)
    expect(out.join("")).toContain("you can edit this project to analyze it")
  })

  test("RV11b: a 404 sessionNotFound keeps the existing not-found wording", async () => {
    const out: string[] = []
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonRes(404, { error: "sessionNotFound" }))
    const code = await reviewCommand("ghost", {
      ai: true,
      ...aiDepsWith(fetchMock as unknown as typeof fetch, out),
    })
    expect(code).toBe(1)
    expect(out.join("")).toContain("No session ghost on this server.")
  })

  test("RV12: --ai --json exits 1 when the lenses array is empty", async () => {
    const out: string[] = []
    const err: string[] = []
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonRes(202, { jobId: "job-9" }))
      .mockResolvedValueOnce(
        jsonRes(200, aiBody({ signals: { model: "glm-5.3", harness: "opencode", lenses: [] } })),
      )
    const code = await reviewCommand("s-1", {
      ai: true,
      json: true,
      ...aiDepsWith(fetchMock as unknown as typeof fetch, out, err),
    })
    expect(code).toBe(1)
    expect(out.join("")).not.toContain('"outcome"')
    expect(err.join("")).toContain("lenses")
  })

  test("RV13: --ai --json prints the raw review JSON and exits 0", async () => {
    const out: string[] = []
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonRes(202, { jobId: "job-9" }))
      .mockResolvedValueOnce(jsonRes(200, aiBody()))
    const code = await reviewCommand("s-1", {
      ai: true,
      json: true,
      ...aiDepsWith(fetchMock as unknown as typeof fetch, out),
    })
    expect(code).toBe(0)
    const printed = JSON.parse(out.join("")) as NonNullable<AiReviewResponse["review"]>
    expect(printed.outcome).toBe("shipped")
    expect(printed.signals.lenses).toHaveLength(3)
  })

  test("RV14: a 409 analysisAlreadyExists reads the landed review back, prints it and exits 0", async () => {
    const out: string[] = []
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonRes(409, { error: "analysisAlreadyExists" }))
      .mockResolvedValueOnce(jsonRes(200, aiBody()))
    const code = await reviewCommand("s-1", {
      ai: true,
      ...aiDepsWith(fetchMock as unknown as typeof fetch, out),
    })
    expect(code).toBe(0)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("/api/sessions/s-1/aireview")
    const text = out.join("")
    expect(text).toContain("Session s-1")
    expect(text).toContain("shipped — work landed (commit or PR)")
  })

  test("RV15: a 409 analysisAlreadyRunning attaches to the job and polls its milestones to the verdict", async () => {
    const out: string[] = []
    const err: string[] = []
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonRes(409, { error: "analysisAlreadyRunning" }))
      // Attach read: the job is running, the review has not landed.
      .mockResolvedValueOnce(
        jsonRes(200, {
          review: null,
          job: {
            jobId: "job-live-1",
            status: "running",
            startedAt: "2026-08-26T09:00:30Z",
            lastEvent: { name: "harness_spawning", at: "2026-08-26T09:00:31Z" },
          },
        }),
      )
      // Poll tick: still nothing (the old 404 shape keeps working too).
      .mockResolvedValueOnce(noAiReview())
      // Progress read on the attached job id.
      .mockResolvedValueOnce(
        jsonRes(200, {
          job: { lastEvent: { name: "harness_first_byte", at: "2026-08-26T09:00:40Z" } },
        }),
      )
      // Poll tick: landed.
      .mockResolvedValueOnce(jsonRes(200, aiBody()))
    const code = await reviewCommand("s-1", {
      ai: true,
      ...aiDepsWith(fetchMock as unknown as typeof fetch, out, err),
      now: () => new Date("2026-08-26T09:01:00Z"),
    })
    expect(code).toBe(0)
    expect(fetchMock).toHaveBeenCalledTimes(5)
    expect(String(fetchMock.mock.calls[2]?.[0])).toContain("/api/sessions/s-1/aireview")
    // The progress read goes to the attached job's id — proof the 409 path joined the
    // right run, not a fresh one.
    expect(String(fetchMock.mock.calls[3]?.[0])).toContain("/api/sessions/s-1/analyze/job-live-1")
    expect(err.join("")).toContain("attaching to the running analysis")
    expect(out.join("")).toContain("shipped — work landed (commit or PR)")
  })
})
