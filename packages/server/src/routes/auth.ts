import { randomBytes } from "node:crypto"
import { zValidator } from "@hono/zod-validator"
import { type PublicUser, publicUserSchema } from "@samskara/core"
import { Hono } from "hono"
import { z } from "zod"
import type { Db } from "../db/client.js"
import {
  clearSessionCookie,
  clearStateCookie,
  readStateCookie,
  setSessionCookie,
  setStateCookie,
} from "../lib/cookies.js"
import type { Env } from "../lib/env.js"
import { signToken } from "../lib/jwt.js"
import { type AuthVariables, requireAuth } from "../lib/require-auth.js"
import {
  NotMemberError,
  type RegisteredOrg,
  type User,
  gateOrgs,
  isSuperAdminLogin,
  revokeAccess,
  syncUserOrgs,
  upsertUserFromGithub,
} from "../services/auth.js"
import type { GithubClient } from "../services/github.js"
import type { PairingStore } from "../services/pairing.js"

type Deps = {
  readonly db: Db
  readonly env: Env
  readonly githubClient: GithubClient
  readonly pairingStore: PairingStore
}

const callbackUrl = (env: Env) => `${env.publicBaseUrl}/api/auth/github/callback`
const webUrl = (env: Env, path: string): string => new URL(path, env.webBaseUrl).toString()

const authorizeUrl = (env: Env, state: string): string => {
  const url = new URL("https://github.com/login/oauth/authorize")
  url.searchParams.set("client_id", env.githubClientId)
  url.searchParams.set("redirect_uri", callbackUrl(env))
  url.searchParams.set("scope", "read:org user:email")
  url.searchParams.set("state", state)
  return url.toString()
}

const callbackQuerySchema = z.object({
  code: z.string().optional(),
  state: z.string().optional(),
})

const cliExchangeSchema = z.object({ code: z.string().min(1) })

const publicUser = (user: User): PublicUser =>
  publicUserSchema.parse({
    id: user.id,
    githubLogin: user.githubLogin,
    email: user.email,
    name: user.name,
    avatarUrl: user.avatarUrl,
    isSuperAdmin: user.isSuperAdmin,
  })

export const authRoutes = ({ db, env, githubClient, pairingStore }: Deps) =>
  new Hono<{ Variables: AuthVariables }>()
    .get("/github/start", (c) => {
      const state = randomBytes(16).toString("hex")
      setStateCookie(c, state, env)
      return c.redirect(authorizeUrl(env, state))
    })
    .get("/github/callback", zValidator("query", callbackQuerySchema), async (c) => {
      const { code, state: queryState } = c.req.valid("query")
      const cookieState = readStateCookie(c)
      if (!queryState || !cookieState || queryState !== cookieState) {
        clearStateCookie(c)
        return c.redirect(webUrl(env, "/?error=bad_state"))
      }
      clearStateCookie(c)

      if (!code) return c.redirect(webUrl(env, "/?error=bad_state"))

      const { accessToken } = await githubClient.exchangeCode(code, callbackUrl(env))
      const [profile, orgSlugs] = await Promise.all([
        githubClient.getProfile(accessToken),
        githubClient.getOrgs(accessToken),
      ])

      const superAdmin = isSuperAdminLogin(env.superAdminLogins, profile.login)

      let registered: ReadonlyArray<RegisteredOrg>
      try {
        registered = (await gateOrgs(db, orgSlugs, { bypass: superAdmin })).registered
      } catch (error) {
        if (error instanceof NotMemberError) {
          await revokeAccess(db, profile.githubId)
          return c.redirect(webUrl(env, "/?error=not_member"))
        }
        throw error
      }

      const user = await upsertUserFromGithub(db, profile, superAdmin)
      await syncUserOrgs(db, user.id, registered)

      const token = await signToken(env, { sub: user.id, aud: "web" })
      setSessionCookie(c, token, env)
      return c.redirect(webUrl(env, "/"))
    })
    .get("/me", requireAuth({ db, env }, ["web", "cli"]), (c) =>
      c.json(publicUser(c.get("user")), 200),
    )
    .post("/logout", requireAuth({ db, env }, ["web"]), (c) => {
      clearSessionCookie(c)
      return c.json({ ok: true }, 200)
    })
    .post("/cli-code", requireAuth({ db, env }, ["web"]), (c) =>
      c.json({ code: pairingStore.mint(c.get("user").id) }, 200),
    )
    .post("/cli-exchange", zValidator("json", cliExchangeSchema), async (c) => {
      const { code } = c.req.valid("json")
      const userId = pairingStore.redeem(code)
      if (!userId) return c.json({ error: "unauthorized" }, 401)

      const token = await signToken(env, { sub: userId, aud: "cli" })
      return c.json({ token }, 200)
    })
