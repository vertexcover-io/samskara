import { SignJWT, jwtVerify } from "jose"
import type { Env } from "./env.js"

export type Audience = "web" | "cli"

const ISSUER = "samskara"

const secretKey = (env: Env) => new TextEncoder().encode(env.jwtSecret)

export const signToken = (env: Env, claims: { sub: string; aud: Audience }): Promise<string> =>
  new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(ISSUER)
    .setAudience(claims.aud)
    .setSubject(claims.sub)
    .setExpirationTime(env.jwtExpiresIn)
    .sign(secretKey(env))

export const verifyToken = async (
  env: Env,
  token: string,
  aud: Audience,
): Promise<{ sub: string } | null> => {
  try {
    const { payload } = await jwtVerify(token, secretKey(env), { issuer: ISSUER, audience: aud })
    if (!payload.sub) return null
    return { sub: payload.sub }
  } catch {
    return null
  }
}
