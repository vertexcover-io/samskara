import { randomUUID } from "node:crypto"
import type { MiddlewareHandler } from "hono"
import type pino from "pino"

const MAX_REQUEST_ID = 128

declare module "hono" {
  interface ContextVariableMap {
    log: pino.Logger
  }
}

export const loggingMiddleware = (rootLog: pino.Logger): MiddlewareHandler => {
  return async (c, next) => {
    const forwarded = c.req.header("x-request-id")?.trim().slice(0, MAX_REQUEST_ID)
    const reqId = forwarded ? forwarded : randomUUID()
    c.header("x-request-id", reqId)

    const userAgent = c.req.header("user-agent")
    const child = rootLog.child({
      reqId,
      method: c.req.method,
      path: new URL(c.req.url).pathname,
      ...(userAgent ? { userAgent } : {}),
    })
    c.set("log", child)

    const start = performance.now()
    await next()
    const ms = Math.round(performance.now() - start)
    child.info({ status: c.res.status, ms }, "request complete")
  }
}
