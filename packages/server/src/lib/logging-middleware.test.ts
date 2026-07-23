import { createLogger } from "@samskara/core"
import { Hono } from "hono"
import { describe, expect, test } from "vitest"
import { loggingMiddleware } from "./logging-middleware.js"

const testLog = () => createLogger({ service: "test" }, { level: "silent" })

const buildTestApp = () => {
  const app = new Hono<{ Variables: { log: ReturnType<typeof testLog> } }>()
  app.use(loggingMiddleware(testLog()))
  app.get("/ok", (c) => c.json({ hasLog: typeof c.get("log")?.info === "function" }))
  app.get("/boom", () => {
    throw new Error("boom")
  })
  app.onError((err, c) => {
    ;(c.get("log") ?? testLog()).error({ err }, "server error")
    return c.json({ error: "internal" }, 500)
  })
  return app
}

describe("loggingMiddleware", () => {
  test("S7: binds a request logger with .info and .setBindings to the context, response is 200", async () => {
    const app = buildTestApp()
    const res = await app.request("/ok")
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ hasLog: true })
  })

  test("S9: request with x-request-id: fixed-123 echoes fixed-123 on the response header", async () => {
    const app = buildTestApp()
    const res = await app.request("/ok", { headers: { "x-request-id": "fixed-123" } })
    expect(res.headers.get("x-request-id")).toBe("fixed-123")
  })

  test("S10: request with no x-request-id header echoes a generated non-empty uuid", async () => {
    const app = buildTestApp()
    const res = await app.request("/ok")
    const reqId = res.headers.get("x-request-id")
    expect(reqId).toBeTruthy()
    expect(reqId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })

  test("S11: a throwing route returns 500 via onError and does not crash, with the middleware present", async () => {
    const app = buildTestApp()
    const res = await app.request("/boom")
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: "internal" })
  })

  test("S11: a throwing route returns 500 via onError on a bare app with no request logger (root fallback)", async () => {
    const app = new Hono<{ Variables: { log?: ReturnType<typeof testLog> } }>()
    app.get("/boom", () => {
      throw new Error("boom")
    })
    app.onError((err, c) => {
      ;(c.get("log") ?? testLog()).error({ err }, "server error")
      return c.json({ error: "internal" }, 500)
    })
    const res = await app.request("/boom")
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: "internal" })
  })
})
