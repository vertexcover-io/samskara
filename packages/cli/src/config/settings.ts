import { readFileSync } from "node:fs"
import { z } from "zod"
import { atomicWriteJson } from "./atomic.js"
import { settingsPath } from "./paths.js"

const settingsSchema = z
  .object({
    version: z.literal(1),
    apiUrl: z.string().min(1),
    webUrl: z.string().min(1),
  })
  .strict()
  .readonly()

export type Settings = z.infer<typeof settingsSchema>
export type Urls = Omit<Settings, "version">

/**
 * Every caller builds a path as `${base}/api/...`, so a trailing slash would produce `//api` and a
 * missing scheme would make `new URL` throw far from where the value was typed. Normalizing once
 * here means a url is either usable everywhere or rejected while the user is still looking at it.
 */
export const normalizeUrl = (value: string): string => {
  const trimmed = value.trim()
  if (trimmed === "") throw new Error("A server URL is required.")
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(trimmed)?.[1]?.toLowerCase()
  if (scheme !== undefined && scheme !== "http" && scheme !== "https") {
    throw new Error(`${value} is not an http or https URL.`)
  }
  const withScheme = scheme === undefined ? `https://${trimmed}` : trimmed
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    throw new Error(`${value} is not a URL. Use something like http://localhost:3000`)
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${value} is not an http or https URL.`)
  }
  if (url.hostname === "") throw new Error(`${value} has no host.`)
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`
}

/**
 * Synchronous and forgiving: `apiBase()` is called from module setup paths that cannot await, and a
 * settings file that will not parse should fall back to the defaults rather than break every
 * command. `samskara init` rewrites it.
 */
export const readSettings = (): Settings | null => {
  try {
    return settingsSchema.parse(JSON.parse(readFileSync(settingsPath(), "utf8")))
  } catch {
    return null
  }
}

export const writeSettings = async (urls: Urls): Promise<string> => {
  const path = settingsPath()
  await atomicWriteJson(path, {
    version: 1,
    apiUrl: normalizeUrl(urls.apiUrl),
    webUrl: normalizeUrl(urls.webUrl),
  } satisfies Settings)
  return path
}
