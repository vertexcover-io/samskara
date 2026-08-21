import { randomUUID } from "node:crypto"
import type { MiddlewareHandler } from "hono"
import type pino from "pino"
import {
  createRequestTiming,
  recordTimingFor,
  runWithRequestTiming,
  timingSnapshot,
} from "./request-timing.js"

const responseByteLength = (response: Response): number | undefined => {
  if (response.body === null) return 0
  const contentLength = response.headers.get("content-length")
  return contentLength && /^\d+$/.test(contentLength) ? Number(contentLength) : undefined
}

const responseHeaderBytes = (response: Response, header: string): number | undefined => {
  const value = response.headers.get(header)
  return value && /^\d+$/.test(value) ? Number(value) : undefined
}

const routeTemplate = (routePath: string): string =>
  routePath === "/*" || routePath === "*" ? "unmatched" : routePath

type LoggingMiddlewareOptions = {
  readonly serverTiming?: boolean
}

export const loggingMiddleware = (
  rootLog: pino.Logger,
  options: LoggingMiddlewareOptions = {},
): MiddlewareHandler<{ Variables: { log: pino.Logger } }> => {
  return async (c, next) => {
    const forwarded = c.req.header("x-request-id")?.trim()
    const reqId = forwarded ? forwarded : randomUUID()
    c.header("x-request-id", reqId)

    const userAgent = c.req.header("user-agent")
    const child = rootLog.child({
      reqId,
      method: c.req.method,
      ...(userAgent ? { userAgent } : {}),
    })
    c.set("log", child)

    const timing = createRequestTiming(reqId)
    const start = performance.now()
    await runWithRequestTiming(timing, () => next())
    const response = c.res
    const totalMs = performance.now() - start
    recordTimingFor(timing, "handler", totalMs)
    const route = routeTemplate(c.req.routePath)
    const timings = timingSnapshot(timing)

    if (options.serverTiming) {
      const serverTiming = Object.entries(timings)
        .map(([name, duration]) => `${name};dur=${duration}`)
        .join(", ")
      if (serverTiming) response.headers.set("server-timing", serverTiming)
    }

    const bodyBytes = responseByteLength(response)
    const uncompressedBytes = responseHeaderBytes(response, "x-response-bytes-uncompressed")
    const wireBytes = responseHeaderBytes(response, "x-response-bytes-wire")
    child.info(
      {
        route,
        status: response.status,
        totalMs: Math.round(totalMs * 100) / 100,
        contentType: response.headers.get("content-type")?.split(";", 1)[0] ?? "none",
        contentEncoding: response.headers.get("content-encoding") ?? "identity",
        cacheOutcome: response.headers.get("x-cache") ?? "none",
        responseBytesUncompressed: uncompressedBytes ?? bodyBytes,
        responseBytesWire: wireBytes ?? bodyBytes,
        timings,
      },
      "request complete",
    )
    return response
  }
}
