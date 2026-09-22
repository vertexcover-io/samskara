import { describe, expect, test } from "vitest"
import { heuristicSessionAnalyzer } from "./analyzer.js"
import type { ReviewEventBody } from "./events.js"
import { sequenceEvents } from "./events.js"

const events = (...bodies: ReviewEventBody[]) => sequenceEvents(bodies)

const prompt = (text = "do the thing"): ReviewEventBody => ({
  kind: "userMessage",
  text,
  isMeta: false,
})

const call = (name: string, id: string): ReviewEventBody => ({
  kind: "toolCall",
  callId: id,
  name,
})

const result = (
  id: string,
  status: "success" | "failure" | "cancelled" | "unknown" = "success",
  name: string | null = null,
): ReviewEventBody => ({ kind: "toolResult", callId: id, name, status })

const analyze = (...bodies: ReviewEventBody[]) =>
  heuristicSessionAnalyzer.analyze({ sessionId: "s1", events: events(...bodies) })

describe("HeuristicSessionAnalyzer signals", () => {
  test("R1: counts turns, prompts, tool calls and failures", () => {
    const review = analyze(
      prompt(),
      call("Bash", "t1"),
      result("t1", "success", "Bash"),
      { kind: "turn", status: "completed" },
      call("Bash", "t2"),
      result("t2", "failure", "Bash"),
      { kind: "turn", status: "completed" },
    )
    expect(review.signals.turns).toBe(2)
    expect(review.signals.userPrompts).toBe(1)
    expect(review.signals.toolCalls).toBe(2)
    expect(review.signals.toolFailures).toBe(1)
    expect(review.signals.toolFailureRate).toBeCloseTo(0.5)
  })

  test("R2: three consecutive same-tool failures form one error loop", () => {
    const review = analyze(
      prompt(),
      call("Bash", "a"),
      result("a", "failure", "Bash"),
      call("Bash", "b"),
      result("b", "failure", "Bash"),
      call("Bash", "c"),
      result("c", "failure", "Bash"),
    )
    expect(review.signals.errorLoops).toHaveLength(1)
    expect(review.signals.errorLoops[0]?.toolName).toBe("Bash")
    expect(review.signals.errorLoops[0]?.consecutiveFailures).toBe(3)
  })

  test("R3: two failures then a success is not an error loop, but is still counted friction-free churn", () => {
    const review = analyze(
      prompt(),
      call("Bash", "a"),
      result("a", "failure", "Bash"),
      call("Bash", "b"),
      result("b", "failure", "Bash"),
      call("Bash", "c"),
      result("c", "success", "Bash"),
    )
    expect(review.signals.errorLoops).toHaveLength(0)
    expect(review.signals.toolFailures).toBe(2)
  })

  test("R4: edits to the same path are churn-counted per path", () => {
    const review = analyze(
      prompt(),
      { kind: "edit", path: "src/a.ts" },
      { kind: "edit", path: "src/a.ts" },
      { kind: "edit", path: "src/b.ts" },
    )
    expect(review.signals.edits).toEqual([
      { path: "src/a.ts", editCount: 2 },
      { path: "src/b.ts", editCount: 1 },
    ])
  })

  test("R5: a prompt after two failures counts as userPromptsAfterFailures", () => {
    const review = analyze(
      prompt("start"),
      call("Bash", "a"),
      result("a", "failure", "Bash"),
      call("Bash", "b"),
      result("b", "failure", "Bash"),
      prompt("no, use the other flag"),
    )
    expect(review.signals.userPromptsAfterFailures).toBe(1)
  })

  test("R6: a prompt after a single failure does not count as after-failure correction", () => {
    const review = analyze(
      prompt("start"),
      call("Bash", "a"),
      result("a", "failure", "Bash"),
      prompt("ok now"),
    )
    expect(review.signals.userPromptsAfterFailures).toBe(0)
  })

  test("R7: meta user messages are not prompts", () => {
    const review = analyze({ kind: "userMessage", text: "<skill-injection>", isMeta: true })
    expect(review.signals.userPrompts).toBe(0)
  })

  test("R8: token events accumulate once per message owner", () => {
    const review = analyze(
      { kind: "tokens", input: 10, output: 5, cached: 2, thinking: 1 },
      { kind: "tokens", input: 7, output: 3, cached: 0, thinking: 0 },
    )
    expect(review.signals.inputTokens).toBe(17)
    expect(review.signals.outputTokens).toBe(8)
    expect(review.signals.cachedTokens).toBe(2)
    expect(review.signals.thinkingTokens).toBe(1)
  })
})

describe("HeuristicSessionAnalyzer outcome and friction", () => {
  test("R10: a commit makes the outcome shipped even with mild failures", () => {
    const review = analyze(
      prompt(),
      call("Bash", "a"),
      result("a", "success", "Bash"),
      { kind: "commit", sha: "abc123" },
      { kind: "turn", status: "completed" },
    )
    expect(review.outcome).toBe("shipped")
    expect(review.friction).toBe("none")
  })

  test("R11: error loops make friction high and outcome struggled", () => {
    const review = analyze(
      prompt(),
      call("Bash", "a"),
      result("a", "failure", "Bash"),
      call("Bash", "b"),
      result("b", "failure", "Bash"),
      call("Bash", "c"),
      result("c", "failure", "Bash"),
      { kind: "turn", status: "completed" },
    )
    expect(review.friction).toBe("high")
    expect(review.outcome).toBe("struggled")
  })

  test("R12: the last turn aborted makes the outcome aborted", () => {
    const review = analyze(
      prompt(),
      call("Bash", "a"),
      result("a", "success", "Bash"),
      { kind: "turn", status: "completed" },
      prompt("more"),
      { kind: "turn", status: "aborted" },
    )
    expect(review.outcome).toBe("aborted")
  })

  test("R13: quiet exploratory session is productive with no friction", () => {
    const review = analyze(
      prompt(),
      call("Grep", "a"),
      result("a", "success", "Grep"),
      { kind: "assistantMessage" },
      { kind: "turn", status: "completed" },
    )
    expect(review.outcome).toBe("productive")
    expect(review.friction).toBe("none")
  })

  test("R14: moderate friction when failure rate is between 10% and 25% with no loop", () => {
    const bodies: ReviewEventBody[] = [prompt()]
    for (let i = 0; i < 10; i += 1) {
      bodies.push(call("Bash", `t${i}`))
      bodies.push(result(`t${i}`, i === 0 || i === 3 ? "failure" : "success", "Bash"))
    }
    const review = analyze(...bodies)
    expect(review.signals.toolFailureRate).toBeCloseTo(0.2)
    expect(review.friction).toBe("moderate")
  })

  test("R15: a shipped session that also fought an error loop is shipped with high friction", () => {
    const review = analyze(
      prompt(),
      call("Bash", "a"),
      result("a", "failure", "Bash"),
      call("Bash", "b"),
      result("b", "failure", "Bash"),
      call("Bash", "c"),
      result("c", "failure", "Bash"),
      call("Bash", "d"),
      result("d", "success", "Bash"),
      { kind: "commit", sha: "abc" },
      { kind: "turn", status: "completed" },
    )
    expect(review.outcome).toBe("shipped")
    expect(review.friction).toBe("high")
  })

  test("R16: summary names the outcome, the volume and the friction in one sentence", () => {
    const review = analyze(
      prompt(),
      call("Bash", "a"),
      result("a", "success", "Bash"),
      { kind: "commit", sha: "abc" },
      { kind: "turn", status: "completed" },
    )
    expect(review.summary).toBe("shipped: 1 turn, 1 tool call, 0 failures, no friction, 1 commit")
  })
})
