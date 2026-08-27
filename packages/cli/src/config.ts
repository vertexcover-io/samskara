import type pino from "pino"
import { z } from "zod"
import { readSettings } from "./config/settings.js"

const ConfigSchema = z.object({
  SAMSKARA_API_URL: z.string().min(1).optional(),
  SAMSKARA_WEB_URL: z.string().min(1).optional(),
})

const url = z.string().min(1)
const dial = z.coerce.number().int().positive()
const POSITIVE_WHOLE = "a positive whole number"

export const DEFAULT_API_URL = "http://localhost:3000"
export const DEFAULT_WEB_URL = "http://localhost:8000"

/** Messages per ingest POST. Chunks within a session are serial, so this bounds one body. */
export const DEFAULT_MESSAGE_CAP = 500

/**
 * Sessions flushed at once. A first sync of a newly-enabled project collects every session at once,
 * and without a ceiling that is one concurrent POST per session -- dozens of multi-megabyte bodies
 * opened together. Sessions keep separate checkpoint keys, so the ceiling only changes when each
 * one runs, never whether it does.
 */
export const DEFAULT_SESSION_CONCURRENCY = 4

export const API_URL_ENV = "SAMSKARA_API_URL"
export const WEB_URL_ENV = "SAMSKARA_WEB_URL"
export const MESSAGE_CAP_ENV = "SAMSKARA_MESSAGE_CAP"
export const SESSION_CONCURRENCY_ENV = "SAMSKARA_SESSION_CONCURRENCY"

const fromEnv = () => ConfigSchema.parse(process.env)

/**
 * Resolved per call rather than frozen at import: `samskara init` writes the settings file and then
 * logs in from the same process, so a value captured at module load would still point at the old
 * server. The environment stays on top so a one-off `SAMSKARA_API_URL=... samskara status` works.
 */
export const apiBase = (): string =>
  fromEnv().SAMSKARA_API_URL ?? readSettings()?.apiUrl ?? DEFAULT_API_URL

export const webBase = (): string =>
  fromEnv().SAMSKARA_WEB_URL ?? readSettings()?.webUrl ?? DEFAULT_WEB_URL

export type ResolvedConfig = {
  readonly apiUrl: string
  readonly webUrl: string
  readonly messageCap: number
  readonly sessionConcurrency: number
}

const resolve = <T>(
  log: pino.Logger,
  name: string,
  schema: z.ZodType<T>,
  fallback: T,
  expected: string,
): T => {
  const value = process.env[name]
  // Unset is the normal case, not a misconfiguration.
  if (value === undefined || value.trim() === "") return fallback
  const parsed = schema.safeParse(value)
  if (parsed.success) return parsed.data
  log.warn({ name, value, fallback }, `${name} is not ${expected}; using ${fallback}`)
  return fallback
}

export const parseConfig = (log: pino.Logger): ResolvedConfig => {
  const settings = readSettings()
  return {
    apiUrl: resolve(log, API_URL_ENV, url, settings?.apiUrl ?? DEFAULT_API_URL, "a url"),
    webUrl: resolve(log, WEB_URL_ENV, url, settings?.webUrl ?? DEFAULT_WEB_URL, "a url"),
    messageCap: resolve(log, MESSAGE_CAP_ENV, dial, DEFAULT_MESSAGE_CAP, POSITIVE_WHOLE),
    sessionConcurrency: resolve(
      log,
      SESSION_CONCURRENCY_ENV,
      dial,
      DEFAULT_SESSION_CONCURRENCY,
      POSITIVE_WHOLE,
    ),
  }
}
