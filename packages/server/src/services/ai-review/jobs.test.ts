import { describe, expect, test } from "vitest"
import { createAiReviewJobRegistry } from "./jobs.js"
import type { AiReviewResult, AiReviewRun } from "./pipeline.js"

const okResult: AiReviewResult = { kind: "ok", reviewId: "review-1", payload: {} as never }

/** A controllable stand-in for runAiReview: the test decides when each call settles. */
const deferredRuns = () => {
  const pending: Array<{
    resolve: (result: AiReviewResult) => void
    reject: (error: unknown) => void
  }> = []
  const run = () =>
    new Promise<AiReviewResult>((resolve, reject) => pending.push({ resolve, reject }))
  return {
    run,
    settleNext: (result: AiReviewResult) => {
      const next = pending.shift()
      if (next === undefined) throw new Error("no pending run to settle")
      next.resolve(result)
    },
    rejectNext: (error: unknown) => {
      const next = pending.shift()
      if (next === undefined) throw new Error("no pending run to reject")
      next.reject(error)
    },
    get outstanding(): number {
      return pending.length
    },
  }
}

const settle = async (
  jobId: string | undefined,
  registry: ReturnType<typeof createAiReviewJobRegistry>,
) => {
  if (jobId === undefined) throw new Error("start returned no jobId")
  for (let i = 0; i < 100; i += 1) {
    const job = registry.getAiReviewJob(jobId)
    if (job !== undefined && job.status !== "running") return job
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error("job never left running")
}

describe("createAiReviewJobRegistry", () => {
  test("J1: a started job is running, then succeeded once the pipeline resolves", async () => {
    const runs = deferredRuns()
    const registry = createAiReviewJobRegistry({ run: runs.run as AiReviewRun })
    const started = registry.startAiReviewJob({} as never, "user-1", "sess-1")
    expect("error" in started && started.error).toBeFalsy()
    const jobId = (started as { jobId: string }).jobId
    expect(registry.getAiReviewJob(jobId)).toMatchObject({ status: "running", sessionId: "sess-1" })

    runs.settleNext(okResult)
    const job = await settle(jobId, registry)
    expect(job).toMatchObject({ status: "succeeded", jobId, reviewId: "review-1" })
  })

  test("J2: a pipeline error result fails the job with its code; a thrown error maps to harnessFailed", async () => {
    const runs = deferredRuns()
    const registry = createAiReviewJobRegistry({ run: runs.run as AiReviewRun })
    const errored = registry.startAiReviewJob({} as never, "user-1", "sess-1")
    runs.settleNext({ kind: "error", code: "unparseable" })
    const failed = await settle((errored as { jobId: string }).jobId, registry)
    expect(failed).toMatchObject({ status: "failed", code: "unparseable" })

    const thrown = registry.startAiReviewJob({} as never, "user-1", "sess-2")
    runs.rejectNext(new Error("unexpected"))
    const crashed = await settle((thrown as { jobId: string }).jobId, registry)
    expect(crashed).toMatchObject({ status: "failed", code: "harnessFailed" })
  })

  test("J3: the fifth concurrent start is busy; a finished slot frees capacity", async () => {
    const runs = deferredRuns()
    const registry = createAiReviewJobRegistry({ run: runs.run as AiReviewRun })
    const jobIds: string[] = []
    for (let i = 0; i < 4; i += 1) {
      const started = registry.startAiReviewJob({} as never, "user-1", `sess-${i}`)
      expect("error" in started && started.error).toBeFalsy()
      jobIds.push((started as { jobId: string }).jobId)
    }
    const fifth = registry.startAiReviewJob({} as never, "user-1", "sess-4")
    expect(fifth).toEqual({ error: "busy" })

    runs.settleNext(okResult)
    await settle(jobIds[0], registry)
    const retry = registry.startAiReviewJob({} as never, "user-1", "sess-4")
    expect("error" in retry && retry.error).toBeFalsy()
  })

  test("J4: an unknown job id is undefined", () => {
    const registry = createAiReviewJobRegistry()
    expect(registry.getAiReviewJob("nope")).toBeUndefined()
  })

  test("J6: activeJobForSession finds the session's running job, and nothing once it settles", async () => {
    const runs = deferredRuns()
    const registry = createAiReviewJobRegistry({ run: runs.run as AiReviewRun })
    expect(registry.activeJobForSession("sess-1")).toBeUndefined()

    const started = registry.startAiReviewJob({} as never, "user-1", "sess-1")
    const jobId = (started as { jobId: string }).jobId
    expect(registry.activeJobForSession("sess-1")).toMatchObject({
      status: "running",
      jobId,
      sessionId: "sess-1",
    })
    // Another session's running job is not this session's.
    expect(registry.activeJobForSession("sess-2")).toBeUndefined()

    runs.settleNext(okResult)
    await settle(jobId, registry)
    expect(registry.activeJobForSession("sess-1")).toBeUndefined()
  })

  test("J5: milestones reported via the pipeline's onMilestone hook surface on the running job", async () => {
    const runs = deferredRuns()
    const registry = createAiReviewJobRegistry({
      run: runs.run as AiReviewRun,
      now: () => new Date("2026-08-26T20:00:00Z"),
    })
    const started = registry.startAiReviewJob({} as never, "user-1", "sess-1")
    const jobId = (started as { jobId: string }).jobId

    // The pipeline invokes `onMilestone` through deps; the registry installed a hook, so
    // each call updates lastEvent on the running job.
    const recorded = (name: string) => registry.recordMilestone(jobId, name)
    recorded("workspace_ready")
    recorded("export_written")
    recorded("harness_spawning")
    expect(registry.getAiReviewJob(jobId)).toMatchObject({
      status: "running",
      lastEvent: { name: "harness_spawning", at: "2026-08-26T20:00:00.000Z" },
    })

    // Once settled, milestones are ignored — the registry keeps the terminal entry intact.
    runs.settleNext(okResult)
    await settle(jobId, registry)
    registry.recordMilestone(jobId, "after-the-fact")
    expect(registry.getAiReviewJob(jobId)).toMatchObject({ status: "succeeded" })
  })
})
