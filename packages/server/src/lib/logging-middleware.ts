import { randomUUID } from "node:crypto"
import type { MiddlewareHandler } from "hono"
import type pino from "pino"

export const loggingMiddleware = (
  rootLog: pino.Logger,
): MiddlewareHandler<{ Variables: { log: pino.Logger } }> => {
  return async (c, next) => {
    const reqId = c.req.header("x-request-id") ?? randomUUID()
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
