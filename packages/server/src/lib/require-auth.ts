import type { Context, MiddlewareHandler } from "hono"
import { getCookie } from "hono/cookie"
import type pino from "pino"
import type { Db } from "../db/client.js"
import { getUserById, type User } from "../services/auth.js"
import { SESSION_COOKIE } from "./cookies.js"
import type { Env } from "./env.js"
import { type Audience, verifyToken } from "./jwt.js"

export type AuthVariables = {
  user: User
  log: pino.Logger
}

type RequireAuthDeps = {
  readonly db: Db
  readonly env: Env
}

const resolveToken = (c: Context): string | null => {
  const cookie = getCookie(c, SESSION_COOKIE)
  if (cookie) return cookie

  const header = c.req.header("authorization")
  if (header?.startsWith("Bearer ")) return header.slice("Bearer ".length)

  return null
}

export const requireAuth =
  (
    { db, env }: RequireAuthDeps,
    accepted: readonly [Audience, ...Audience[]],
  ): MiddlewareHandler<{ Variables: AuthVariables }> =>
  async (c, next) => {
    const token = resolveToken(c)
    if (!token) {
      c.get("log")?.debug("auth rejected: no token")
      return c.json({ error: "unauthorized" }, 401)
    }

    const verified = await verifyToken(env, token, accepted)
    if (!verified) {
      c.get("log")?.warn({ accepted }, "auth rejected: token not valid for this endpoint")
      return c.json({ error: "unauthorized" }, 401)
    }

    const user = await getUserById(db, verified.sub)
    if (!user) {
      c.get("log")?.warn({ sub: verified.sub }, "auth rejected: no user row for this token")
      return c.json({ error: "unauthorized" }, 401)
    }

    c.set("user", user)
    c.get("log")?.setBindings({ userId: user.id })
    return next()
  }
