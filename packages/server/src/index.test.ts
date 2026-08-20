import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, test, vi } from "vitest"

const source = readFileSync(fileURLToPath(new URL("./index.ts", import.meta.url)), "utf-8")

describe("server boot", () => {
  test("S12: index.ts contains no console.log and references the root logger", () => {
    expect(source).not.toMatch(/console\.log/)
    expect(source).toMatch(/rootLog/)
  })
})

describe("B3/B4: the server still listens when the search index check fails", () => {
  const originalDatabaseUrl = process.env.DATABASE_URL

  afterEach(() => {
    process.env.DATABASE_URL = originalDatabaseUrl
    vi.resetModules()
    vi.doUnmock("@hono/node-server")
    vi.doUnmock("./app.js")
    vi.doUnmock("./db/client.js")
    vi.doUnmock("./lib/env.js")
    vi.doUnmock("./scripts/create-search-indexes.js")
  })

  // S13's replacement: the previous test only grepped index.ts's source for the call's name,
  // which is satisfied by the import line alone and stays green even if the call is commented
  // out. This drives the actual module with the search-index check rejecting, and proves the
  // server still binds its port -- an unreachable database must cost search, not boot.
  test("serve() is still invoked after warnMissingSearchIndexes rejects", async () => {
    process.env.DATABASE_URL = "postgres://test:test@localhost:1/test"
    const serve = vi.fn()
    vi.doMock("@hono/node-server", () => ({ serve }))
    vi.doMock("./app.js", () => ({ buildApp: () => ({ fetch: vi.fn() }) }))
    vi.doMock("./db/client.js", () => ({ createDb: () => ({ db: {}, client: {} }) }))
    vi.doMock("./lib/env.js", () => ({ loadEnv: () => ({}) }))
    vi.doMock("./scripts/create-search-indexes.js", () => ({
      warnMissingSearchIndexes: () => Promise.reject(new Error("database unreachable")),
    }))

    await import("./index.js")

    expect(serve).toHaveBeenCalledOnce()
  })
})
