import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createLogger } from "@samskara/core"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { buildApp } from "./app.js"
import type { Db } from "./db/client.js"
import type { Env } from "./lib/env.js"

const silentLog = () => createLogger({ service: "test" }, { level: "silent" })

const env: Env = {
  githubClientId: "test-client-id",
  githubClientSecret: "test-client-secret",
  publicBaseUrl: "http://localhost:3000",
  webBaseUrl: "http://localhost:8000",
  cookieSecure: false,
  jwtSecret: "test-secret",
  jwtExpiresIn: "7d",
  superAdminLogins: [],
  webDist: "tmp-web-dist-fixture",
}

const fixtureRoot = join(process.cwd(), env.webDist as string)

const INDEX_HTML = '<!doctype html><html><body><div id="root"></div></body></html>'

beforeAll(() => {
  mkdirSync(join(fixtureRoot, "assets"), { recursive: true })
  writeFileSync(join(fixtureRoot, "index.html"), INDEX_HTML)
  writeFileSync(join(fixtureRoot, "assets", "main-abc123.js"), "console.info('bundle')")
})

afterAll(() => {
  rmSync(fixtureRoot, { recursive: true, force: true })
})

const app = () => buildApp({} as Db, env, { rootLog: silentLog() })

describe("static web assets", () => {
  test("S1: GET / serves the built index.html rather than a 404", async () => {
    const res = await app().request("/")
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('<div id="root">')
  })

  test("S2: a hashed asset is served with its own content", async () => {
    const res = await app().request("/assets/main-abc123.js")
    expect(res.status).toBe(200)
    expect(await res.text()).toContain("bundle")
  })

  test("S3: an unknown client-side route falls back to index.html so the SPA router can render it", async () => {
    const res = await app().request("/sessions/42")
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('<div id="root">')
  })

  test("S4: the static fallback never shadows the API — unmatched /api paths still 404 as JSON", async () => {
    const res = await app().request("/api/does-not-exist")
    expect(res.status).toBe(404)
    expect(res.headers.get("content-type")).not.toContain("text/html")
  })

  test("S5: /health still returns the JSON health payload", async () => {
    const res = await app().request("/health")
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: "ok" })
  })

  test("S7: /api/health answers the platform health probe", async () => {
    const res = await app().request("/api/health")
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: "ok" })
  })
})

describe("static web assets when WEB_DIST is unset", () => {
  test("S6: with no webDist configured the app serves the API only and / is a plain 404", async () => {
    const apiOnly = buildApp({} as Db, { ...env, webDist: undefined }, { rootLog: silentLog() })
    const res = await apiOnly.request("/")
    expect(res.status).toBe(404)
    expect(res.headers.get("content-type")).not.toContain("text/html")
  })
})
