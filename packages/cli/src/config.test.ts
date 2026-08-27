import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { writeSettings } from "./config/settings.js"
import {
  apiBase,
  DEFAULT_MESSAGE_CAP,
  DEFAULT_SESSION_CONCURRENCY,
  parseConfig,
  webBase,
} from "./config.js"
import { spyLogger } from "./watcher/test-logger.js"

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

describe("parseConfig", () => {
  test("falls back to the code defaults when nothing is configured, saying nothing", () => {
    const spy = spyLogger()

    expect(parseConfig(spy.log)).toEqual({
      apiUrl: "http://localhost:3000",
      webUrl: "http://localhost:8000",
      messageCap: DEFAULT_MESSAGE_CAP,
      sessionConcurrency: DEFAULT_SESSION_CONCURRENCY,
    })
    expect(spy.warn).toEqual([])
  })

  test("takes every dial from the environment when they are usable", () => {
    process.env.SAMSKARA_API_URL = "http://localhost:3999"
    process.env.SAMSKARA_MESSAGE_CAP = "1200"
    process.env.SAMSKARA_SESSION_CONCURRENCY = "2"
    const spy = spyLogger()

    const resolved = parseConfig(spy.log)

    expect(resolved.apiUrl).toBe("http://localhost:3999")
    expect(resolved.messageCap).toBe(1200)
    expect(resolved.sessionConcurrency).toBe(2)
    expect(spy.warn).toEqual([])
  })

  test("falls back to the saved settings file before the code default", async () => {
    await writeSettings({ apiUrl: "https://api.acme.dev", webUrl: "https://acme.dev" })
    const spy = spyLogger()

    const resolved = parseConfig(spy.log)

    expect(resolved.apiUrl).toBe("https://api.acme.dev")
    expect(resolved.webUrl).toBe("https://acme.dev")
  })

  /**
   * Never a throw. The watch loop catches everything a cycle raises, so a value that threw would
   * leave a daemon alive, logging one line every cycle and never syncing.
   */
  test.each(["zero", "0", "-1", "2.5"])(
    "%o is warned about once and replaced by the default rather than throwing",
    (value) => {
      process.env.SAMSKARA_SESSION_CONCURRENCY = value
      const spy = spyLogger()

      expect(parseConfig(spy.log).sessionConcurrency).toBe(DEFAULT_SESSION_CONCURRENCY)
      expect(spy.warn).toHaveLength(1)
      expect(spy.warn[0]?.message).toContain("SAMSKARA_SESSION_CONCURRENCY")
      expect(spy.warn[0]?.details).toMatchObject({ value, fallback: DEFAULT_SESSION_CONCURRENCY })
    },
  )

  test("warns once per unusable dial, naming each one", () => {
    process.env.SAMSKARA_MESSAGE_CAP = "lots"
    process.env.SAMSKARA_SESSION_CONCURRENCY = "-3"
    const spy = spyLogger()

    parseConfig(spy.log)

    expect(spy.warn.map((entry) => entry.details.name)).toEqual([
      "SAMSKARA_MESSAGE_CAP",
      "SAMSKARA_SESSION_CONCURRENCY",
    ])
  })
})
