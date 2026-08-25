import { z } from "zod"
import { readSettings } from "./config/settings.js"

const ConfigSchema = z.object({
  SAMSKARA_API_URL: z.string().min(1).optional(),
  SAMSKARA_WEB_URL: z.string().min(1).optional(),
})

export const DEFAULT_API_URL = "http://localhost:3000"
export const DEFAULT_WEB_URL = "http://localhost:8000"

export const API_URL_ENV = "SAMSKARA_API_URL"
export const WEB_URL_ENV = "SAMSKARA_WEB_URL"

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
