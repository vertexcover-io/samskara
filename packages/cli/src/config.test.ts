import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { writeSettings } from "./config/settings.js"
import { apiBase, webBase } from "./config.js"

const original = {
  home: process.env.SAMSKARA_HOME,
  api: process.env.SAMSKARA_API_URL,
  web: process.env.SAMSKARA_WEB_URL,
}

const restore = (key: string, value: string | undefined): void => {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

beforeEach(async () => {
  process.env.SAMSKARA_HOME = await mkdtemp(join(tmpdir(), "samskara-config-"))
  delete process.env.SAMSKARA_API_URL
  delete process.env.SAMSKARA_WEB_URL
})

afterEach(() => {
  restore("SAMSKARA_HOME", original.home)
  restore("SAMSKARA_API_URL", original.api)
  restore("SAMSKARA_WEB_URL", original.web)
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
