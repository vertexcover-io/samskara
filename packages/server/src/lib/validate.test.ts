import { Hono } from "hono"
import { describe, expect, test } from "vitest"
import { z } from "zod"
import { loggingMiddleware } from "./logging-middleware.js"
import { captureLogger } from "./test-logger.js"
import { validate } from "./validate.js"

const schema = z.object({ sessionId: z.string().min(1), count: z.number() })

const buildApp = (log: ReturnType<typeof captureLogger>["log"]) =>
  new Hono()
    .use(loggingMiddleware(log))
    .post("/thing", validate("json", schema), (c) => c.json({ ok: true }, 200))
    .get("/query", validate("query", z.object({ which: z.enum(["a", "b"]) })), (c) =>
      c.json({ ok: true }, 200),
    )

const post = (app: Hono, body: unknown) =>
  app.request("/thing", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })

describe("validate", () => {
  test("a valid body passes through untouched and logs no warning", async () => {
    const capture = captureLogger()
    const res = await post(buildApp(capture.log), { sessionId: "s1", count: 2 })

    expect(res.status).toBe(200)
    expect(capture.at("warn")).toHaveLength(0)
  })

  test("an invalid body still answers 400 -- the hook only observes, it never changes the response", async () => {
    const capture = captureLogger()
    const res = await post(buildApp(capture.log), { sessionId: "", count: "two" })

    expect(res.status).toBe(400)
  })

  test("an invalid body logs one warning naming every bad field, so a 400 is diagnosable", async () => {
    const capture = captureLogger()
    await post(buildApp(capture.log), { sessionId: "", count: "two" })

    const [line] = capture.at("warn")
    expect(line?.msg).toBe("request validation failed")
    expect(line?.target).toBe("json")
    const paths = (line?.issues as ReadonlyArray<{ path: string }> | undefined)?.map(
      (issue) => issue.path,
    )
    expect([...(paths ?? [])].sort()).toEqual(["count", "sessionId"])
  })

  test("the warning carries the request id, so a rejected payload joins the rest of its request", async () => {
    const capture = captureLogger()
    const app = buildApp(capture.log)
    await app.request("/thing", {
      method: "POST",
      headers: { "content-type": "application/json", "x-request-id": "fixed-123" },
      body: JSON.stringify({ sessionId: "" }),
    })

    expect(capture.at("warn")[0]?.reqId).toBe("fixed-123")
  })

  test("the warning never echoes the submitted data, which for ingest is the whole transcript", async () => {
    const capture = captureLogger()
    await post(buildApp(capture.log), { sessionId: "", count: "two", secretPayload: "do-not-log" })

    expect(JSON.stringify(capture.lines)).not.toContain("do-not-log")
  })

  test("a query target is validated and reported the same way", async () => {
    const capture = captureLogger()
    const res = await buildApp(capture.log).request("/query?which=zzz")

    expect(res.status).toBe(400)
    expect(capture.at("warn")[0]?.target).toBe("query")
  })
})
