import { createLogger } from "@samskara/core"
import { Hono } from "hono"
import { describe, expect, test } from "vitest"
import { buildApp } from "../app.js"
import type { Db } from "../db/client.js"
import type { Env } from "./env.js"
import { loggingMiddleware } from "./logging-middleware.js"

const testLog = () => createLogger({ service: "test" }, { level: "silent" })

const buildTestApp = () => {
  const app = new Hono<{ Variables: { log: ReturnType<typeof testLog> } }>()
  app.use(loggingMiddleware(testLog()))
  app.get("/ok", (c) => {
    const log = c.get("log")
    log?.setBindings({ userId: "user-9" })
    const bindings = log?.bindings() ?? {}
    return c.json({ reqId: bindings.reqId, userId: bindings.userId })
  })
  return app
}

describe("loggingMiddleware", () => {
  test("S7/S9: request with x-request-id: fixed-123 binds it to the request logger, accepts later bindings, and echoes it on the response header", async () => {
    const app = buildTestApp()
    const res = await app.request("/ok", { headers: { "x-request-id": "fixed-123" } })
    expect(res.status).toBe(200)
    expect(res.headers.get("x-request-id")).toBe("fixed-123")
    expect(await res.json()).toEqual({ reqId: "fixed-123", userId: "user-9" })
  })

  test.each([
    ["no x-request-id header", {}],
    ["a blank x-request-id header", { "x-request-id": "   " }],
  ])(
    "S10: a request with %s echoes a generated uuid, not an empty reqId",
    async (_case, headers) => {
      const app = buildTestApp()
      const res = await app.request("/ok", { headers })
      expect(res.headers.get("x-request-id")).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      )
    },
  )

  test("S11: the real buildApp app routes an unhandled throw through onError as 500", async () => {
    const env: Env = {
      githubClientId: "id",
      githubClientSecret: "secret",
      publicBaseUrl: "http://localhost:3000",
      webBaseUrl: "http://localhost:8000",
      cookieSecure: false,
      jwtSecret: "test-secret-value",
      jwtExpiresIn: "7d",
      superAdminLogins: [],
      aiReviewHarness: "opencode",
      aiReviewModel: "zai-coding-plan/glm-5.3-flash",
      aiReviewTimeoutMs: 600_000,
    }
    const app = buildApp({} as Db, env, { rootLog: testLog() })
    app.get("/__boom", () => {
      throw new Error("boom")
    })
    const res = await app.request("/__boom")
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: "internal" })
  })
})

describe("loggingMiddleware request id hardening", () => {
  test("S12: an oversized x-request-id is capped, so a junk header cannot bloat every log line", async () => {
    const app = buildTestApp()
    const res = await app.request("/ok", { headers: { "x-request-id": "a".repeat(500) } })

    expect(res.headers.get("x-request-id")).toBe("a".repeat(128))
  })
})
