import type { Context } from "hono"
import { deleteCookie, getCookie, setCookie } from "hono/cookie"
import type { Env } from "./env.js"

const STATE_COOKIE = "oauth_state"
export const SESSION_COOKIE = "session"
const STATE_MAX_AGE = 60 * 10
const SESSION_MAX_AGE = 60 * 60 * 24 * 7

export const setStateCookie = (c: Context, state: string, env: Env): void => {
  setCookie(c, STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "Lax",
    secure: env.cookieSecure,
    path: "/",
    maxAge: STATE_MAX_AGE,
  })
}

export const readStateCookie = (c: Context): string | undefined => getCookie(c, STATE_COOKIE)

export const clearStateCookie = (c: Context): void => {
  deleteCookie(c, STATE_COOKIE, { path: "/" })
}

export const setSessionCookie = (c: Context, token: string, env: Env): void => {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "Lax",
    secure: env.cookieSecure,
    path: "/",
    maxAge: SESSION_MAX_AGE,
  })
}

export const clearSessionCookie = (c: Context): void => {
  deleteCookie(c, SESSION_COOKIE, { path: "/" })
}
