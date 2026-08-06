import { createLogger } from "@samskara/core"
import type pino from "pino"

export type LogCall = {
  readonly details: Record<string, unknown>
  readonly message: string
}

export type SpyLogger = {
  readonly log: pino.Logger
  readonly debug: ReadonlyArray<LogCall>
  readonly warn: ReadonlyArray<LogCall>
  readonly error: ReadonlyArray<LogCall>
}

/**
 * A real silent pino logger with `debug`/`warn`/`error` recorded, for the tests that assert a level
 * fired -- the queue's depth signal, the oversize-artifact skip, and a permanently rejected upload
 * are behavior, not noise. Wrapping the real logger rather than substituting a stub keeps the
 * production signature honest: these modules take a `pino.Logger` like every other module.
 */
export const spyLogger = (): SpyLogger => {
  const log = createLogger({ service: "samskara-cli-test" }, { level: "silent" })
  const debug: LogCall[] = []
  const warn: LogCall[] = []
  const error: LogCall[] = []

  const record = (into: LogCall[], original: pino.LogFn): pino.LogFn =>
    ((details: unknown, message?: string) => {
      if (typeof details === "object" && details !== null && typeof message === "string") {
        into.push({ details: details as Record<string, unknown>, message })
      }
      return (original as (...args: unknown[]) => void).call(log, details, message)
    }) as pino.LogFn

  log.debug = record(debug, log.debug.bind(log))
  log.warn = record(warn, log.warn.bind(log))
  log.error = record(error, log.error.bind(log))

  return { log, debug, warn, error }
}

/** A real silent logger for tests that do not inspect what was logged. */
export const silentLogger = (): pino.Logger =>
  createLogger({ service: "samskara-cli-test" }, { level: "silent" })
