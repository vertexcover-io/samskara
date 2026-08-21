import { createLogger } from "@samskara/core"
import { Hono } from "hono"
import pino from "pino"
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
  test("S7: the bound request logger carries the request id and accepts later bindings", async () => {
    const app = buildTestApp()
    const res = await app.request("/ok", { headers: { "x-request-id": "fixed-123" } })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ reqId: "fixed-123", userId: "user-9" })
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

  test("S10: a blank x-request-id header falls back to a generated uuid, not an empty reqId", async () => {
    const app = buildTestApp()
    const res = await app.request("/ok", { headers: { "x-request-id": "   " } })
    const reqId = res.headers.get("x-request-id")
    expect(reqId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })

  test("emits stable route labels and response byte metrics without exposing path ids", async () => {
    const entries: Array<Record<string, unknown>> = []
    const rootLog = pino({ level: "info" }, { write: (line) => entries.push(JSON.parse(line)) })
    const app = new Hono<{ Variables: { log: ReturnType<typeof testLog> } }>()
    app.use(loggingMiddleware(rootLog))
    app.get("/sessions/:id", (c) =>
      c.body('{"value":"é"}', 200, {
        "content-length": "14",
        "content-type": "application/json",
      }),
    )

    const res = await app.request("/sessions/session-private")
    expect(res.status).toBe(200)
    expect(entries).toContainEqual(
      expect.objectContaining({
        route: "/sessions/:id",
        contentType: "application/json",
        contentEncoding: "identity",
        responseBytesUncompressed: Buffer.byteLength('{"value":"é"}'),
        responseBytesWire: Buffer.byteLength('{"value":"é"}'),
      }),
    )
    expect(JSON.stringify(entries)).not.toContain("session-private")
  })

  test("records undefined byte fields when no byte headers are available", async () => {
    const entries: Array<Record<string, unknown>> = []
    const rootLog = pino({ level: "info" }, { write: (line) => entries.push(JSON.parse(line)) })
    const app = new Hono<{ Variables: { log: ReturnType<typeof testLog> } }>()
    app.use(loggingMiddleware(rootLog))
    app.get("/stream", (c) => c.text("body without content length"))

    await app.request("/stream")
    expect(entries).toContainEqual(
      expect.not.objectContaining({ responseBytesUncompressed: expect.anything() }),
    )
    expect(entries).toContainEqual(
      expect.not.objectContaining({ responseBytesWire: expect.anything() }),
    )
  })

  test("emits Server-Timing only when enabled by server configuration", async () => {
    const disabled = buildTestApp()
    expect(
      (await disabled.request("/ok", { headers: { "x-server-timing": "1" } })).headers.get(
        "server-timing",
      ),
    ).toBeNull()

    const app = new Hono<{ Variables: { log: ReturnType<typeof testLog> } }>()
    app.use(loggingMiddleware(testLog(), { serverTiming: true }))
    app.get("/ok", (c) => c.text("ok"))
    expect((await app.request("/ok")).headers.get("server-timing")).toMatch(/handler;dur=/)
  })

  test("S11: the real buildApp app routes an unhandled throw through onError as 500", async () => {
    const env: Env = {
      githubClientId: "id",
      githubClientSecret: "secret",
      publicBaseUrl: "http://localhost:3000",
      webBaseUrl: "http://localhost:8000",
      cookieSecure: false,
      jwtSecret: "test-secret-value",
      jwtExpiresIn: "7d",
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
