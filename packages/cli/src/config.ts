import { z } from "zod"
import { readSettings } from "./config/settings.js"

/**
 * A dial left unset falls back to the code default below; a dial set to nonsense stops the process
 * rather than falling back. The daemon runs unattended for days, so a typo that silently reverted
 * to the default would show up only as throughput nobody chose.
 */
const dial = z.coerce.number().int().positive().optional()

const ConfigSchema = z.object({
  SAMSKARA_API_URL: z.string().min(1).optional(),
  SAMSKARA_WEB_URL: z.string().min(1).optional(),
  SAMSKARA_MESSAGE_CAP: dial,
  SAMSKARA_SESSION_CONCURRENCY: dial,
})

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

export const messageCap = (): number => fromEnv().SAMSKARA_MESSAGE_CAP ?? DEFAULT_MESSAGE_CAP

export const sessionConcurrency = (): number =>
  fromEnv().SAMSKARA_SESSION_CONCURRENCY ?? DEFAULT_SESSION_CONCURRENCY
