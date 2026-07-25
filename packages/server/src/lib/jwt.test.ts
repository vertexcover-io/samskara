import { SignJWT } from "jose"
import { describe, expect, test } from "vitest"
import type { Env } from "./env.js"
import { signToken, verifyToken } from "./jwt.js"

const env: Env = {
  githubClientId: "cid",
  githubClientSecret: "secret",
  publicBaseUrl: "http://localhost:3000",
  webBaseUrl: "http://localhost:8000",
  cookieSecure: false,
  jwtSecret: "test-secret-value",
  jwtExpiresIn: "7d",
}

describe("S5: jwt sign/verify", () => {
  test("round-trips sub and aud for a web token", async () => {
    const token = await signToken(env, { sub: "user-1", aud: "web" })
    expect(await verifyToken(env, token, "web")).toEqual({ sub: "user-1" })
  })

  test("returns null for a web token verified against cli audience", async () => {
    const token = await signToken(env, { sub: "user-1", aud: "web" })
    expect(await verifyToken(env, token, "cli")).toBeNull()
  })

  test("returns null for a token signed with a different secret (tampered)", async () => {
    const token = await signToken(env, { sub: "user-1", aud: "web" })
    expect(await verifyToken({ ...env, jwtSecret: "other-secret" }, token, "web")).toBeNull()
  })

  test("returns null for an expired token", async () => {
    const expired = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer("samskara")
      .setAudience("web")
      .setSubject("user-1")
      .setExpirationTime("-1h")
      .sign(new TextEncoder().encode(env.jwtSecret))
    expect(await verifyToken(env, expired, "web")).toBeNull()
  })

  test("returns null for a token with the wrong issuer", async () => {
    const wrongIssuer = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer("evil")
      .setAudience("web")
      .setSubject("user-1")
      .setExpirationTime("7d")
      .sign(new TextEncoder().encode(env.jwtSecret))
    expect(await verifyToken(env, wrongIssuer, "web")).toBeNull()
  })
})
