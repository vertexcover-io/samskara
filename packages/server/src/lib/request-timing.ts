import { AsyncLocalStorage } from "node:async_hooks"

export const REQUEST_TIMING_PHASES = [
  "auth.jwt",
  "auth.user",
  "db.queue",
  "db.execute",
  "serialize",
  "compress",
  "handler",
] as const

export type RequestTimingPhase = (typeof REQUEST_TIMING_PHASES)[number]

export type RequestTiming = {
  readonly requestId: string
  readonly durations: Map<RequestTimingPhase, number>
}

const storage = new AsyncLocalStorage<RequestTiming>()

export const createRequestTiming = (requestId: string): RequestTiming => ({
  requestId,
  durations: new Map(),
})

export const runWithRequestTiming = <T>(timing: RequestTiming, callback: () => T): T =>
  storage.run(timing, callback)

export const currentRequestTiming = (): RequestTiming | undefined => storage.getStore()

export const recordTiming = (phase: RequestTimingPhase, durationMs: number): void => {
  const timing = currentRequestTiming()
  if (timing) recordTimingFor(timing, phase, durationMs)
}

export const recordTimingFor = (
  timing: RequestTiming | undefined,
  phase: RequestTimingPhase,
  durationMs: number,
): void => {
  if (!timing || !Number.isFinite(durationMs) || durationMs < 0) return
  timing.durations.set(phase, (timing.durations.get(phase) ?? 0) + durationMs)
}

export const timePhase = <T>(phase: RequestTimingPhase, callback: () => T): T => {
  const startedAt = performance.now()
  try {
    const result = callback()
    if (result instanceof Promise) {
      return result.finally(() => recordTiming(phase, performance.now() - startedAt)) as T
    }
    recordTiming(phase, performance.now() - startedAt)
    return result
  } catch (error) {
    recordTiming(phase, performance.now() - startedAt)
    throw error
  }
}

export const timingSnapshot = (
  timing: RequestTiming,
): Partial<Record<RequestTimingPhase, number>> =>
  Object.fromEntries(
    [...timing.durations.entries()].map(([phase, durationMs]) => [
      phase,
      Math.round(durationMs * 100) / 100,
    ]),
  )
