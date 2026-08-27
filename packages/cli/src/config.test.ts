import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { writeSettings } from "./config/settings.js"
import {
  apiBase,
  DEFAULT_MESSAGE_CAP,
  DEFAULT_SESSION_CONCURRENCY,
  messageCap,
  sessionConcurrency,
  webBase,
} from "./config.js"

const original = {
  home: process.env.SAMSKARA_HOME,
  api: process.env.SAMSKARA_API_URL,
  web: process.env.SAMSKARA_WEB_URL,
  cap: process.env.SAMSKARA_MESSAGE_CAP,
  concurrency: process.env.SAMSKARA_SESSION_CONCURRENCY,
}

const restore = (key: string, value: string | undefined): void => {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

beforeEach(async () => {
  process.env.SAMSKARA_HOME = await mkdtemp(join(tmpdir(), "samskara-config-"))
  delete process.env.SAMSKARA_API_URL
  delete process.env.SAMSKARA_WEB_URL
  delete process.env.SAMSKARA_MESSAGE_CAP
  delete process.env.SAMSKARA_SESSION_CONCURRENCY
})

afterEach(() => {
  restore("SAMSKARA_HOME", original.home)
  restore("SAMSKARA_API_URL", original.api)
  restore("SAMSKARA_WEB_URL", original.web)
  restore("SAMSKARA_MESSAGE_CAP", original.cap)
  restore("SAMSKARA_SESSION_CONCURRENCY", original.concurrency)
})

describe("server url resolution", () => {
  test("falls back to localhost when nothing is configured", () => {
    expect(apiBase()).toBe("http://localhost:3000")
    expect(webBase()).toBe("http://localhost:8000")
  })

  test("uses the saved settings file", async () => {
    await writeSettings({ apiUrl: "https://api.acme.dev", webUrl: "https://acme.dev" })

    expect(apiBase()).toBe("https://api.acme.dev")
    expect(webBase()).toBe("https://acme.dev")
  })

  test("the environment wins over the saved file", async () => {
    await writeSettings({ apiUrl: "https://api.acme.dev", webUrl: "https://acme.dev" })
    process.env.SAMSKARA_API_URL = "http://localhost:3999"
    process.env.SAMSKARA_WEB_URL = "http://localhost:8999"

    expect(apiBase()).toBe("http://localhost:3999")
    expect(webBase()).toBe("http://localhost:8999")
  })

  test("reads the file on every call, so a url saved mid-process takes effect", async () => {
    expect(apiBase()).toBe("http://localhost:3000")

    await writeSettings({ apiUrl: "http://box:3000", webUrl: "http://box:8000" })

    expect(apiBase()).toBe("http://box:3000")
  })
})

describe("ingest fan-out tuning", () => {
  test("falls back to the code defaults when nothing is configured", () => {
    expect(messageCap()).toBe(DEFAULT_MESSAGE_CAP)
    expect(sessionConcurrency()).toBe(DEFAULT_SESSION_CONCURRENCY)
  })

  test("the environment overrides both dials", () => {
    process.env.SAMSKARA_MESSAGE_CAP = "1200"
    process.env.SAMSKARA_SESSION_CONCURRENCY = "2"

    expect(messageCap()).toBe(1200)
    expect(sessionConcurrency()).toBe(2)
  })

  test("reads the environment on every call, so the daemon is not frozen at import", () => {
    expect(messageCap()).toBe(DEFAULT_MESSAGE_CAP)

    process.env.SAMSKARA_MESSAGE_CAP = "750"

    expect(messageCap()).toBe(750)
  })

  /**
   * A dial that silently ignores a typo is worse than one that refuses to start: the daemon would
   * run for days at a value nobody chose, and the only symptom is throughput.
   */
  test("a value that is not a positive whole number fails loudly rather than falling back", () => {
    process.env.SAMSKARA_SESSION_CONCURRENCY = "zero"
    expect(() => sessionConcurrency()).toThrow(/SAMSKARA_SESSION_CONCURRENCY/)

    process.env.SAMSKARA_SESSION_CONCURRENCY = "0"
    expect(() => sessionConcurrency()).toThrow(/SAMSKARA_SESSION_CONCURRENCY/)

    process.env.SAMSKARA_SESSION_CONCURRENCY = "2.5"
    expect(() => sessionConcurrency()).toThrow(/SAMSKARA_SESSION_CONCURRENCY/)
  })
})
