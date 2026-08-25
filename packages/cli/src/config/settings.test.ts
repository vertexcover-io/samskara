import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { normalizeUrl, readSettings, writeSettings } from "./settings.js"

const originalHome = process.env.SAMSKARA_HOME

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "samskara-settings-"))
  process.env.SAMSKARA_HOME = home
})

afterEach(() => {
  process.env.SAMSKARA_HOME = originalHome
})

describe("normalizeUrl", () => {
  test("keeps a plain origin untouched", () => {
    expect(normalizeUrl("http://localhost:3000")).toBe("http://localhost:3000")
  })

  test("drops trailing slashes, so a joined path never doubles up", () => {
    expect(normalizeUrl("https://samskara.example.com/")).toBe("https://samskara.example.com")
    expect(normalizeUrl("  http://localhost:3000//  ")).toBe("http://localhost:3000")
  })

  test("assumes https when no scheme is given", () => {
    expect(normalizeUrl("samskara.example.com")).toBe("https://samskara.example.com")
  })

  test("rejects anything that is not a usable http url", () => {
    expect(() => normalizeUrl("")).toThrow()
    expect(() => normalizeUrl("ftp://example.com")).toThrow()
    expect(() => normalizeUrl("not a url")).toThrow()
  })
})

describe("settings file", () => {
  test("reads back what it wrote", async () => {
    await writeSettings({ apiUrl: "http://box:3000", webUrl: "http://box:8000" })

    expect(readSettings()).toEqual({
      version: 1,
      apiUrl: "http://box:3000",
      webUrl: "http://box:8000",
    })
  })

  test("answers null when nothing has been saved yet", () => {
    expect(readSettings()).toBeNull()
  })

  test("answers null for an unreadable file rather than throwing", async () => {
    await writeFile(join(home, "config.json"), "{ not json", "utf8")

    expect(readSettings()).toBeNull()
  })

  test("normalizes on write, so a trailing slash never reaches the file", async () => {
    const path = await writeSettings({
      apiUrl: "http://box:3000/",
      webUrl: "http://box:8000/",
    })

    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      version: 1,
      apiUrl: "http://box:3000",
      webUrl: "http://box:8000",
    })
  })
})
