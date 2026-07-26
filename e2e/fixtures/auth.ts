import { type Page, test as base } from "@playwright/test"
import { SignJWT } from "jose"
import { E2E_USER_ID } from "../seed.js"

const JWT_SECRET = process.env.JWT_SECRET ?? "e2e-secret"

export const mintSessionToken = (subject: string = E2E_USER_ID): Promise<string> =>
  new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("samskara")
    .setAudience("web")
    .setSubject(subject)
    .setExpirationTime("7d")
    .sign(new TextEncoder().encode(JWT_SECRET))

export const test = base.extend<{ authedPage: Page }>({
  authedPage: async ({ page, context }, use) => {
    const token = await mintSessionToken()
    await context.addCookies([
      {
        name: "session",
        value: token,
        domain: "localhost",
        path: "/",
        httpOnly: true,
        sameSite: "Lax",
      },
    ])
    await use(page)
  },
})

export { expect } from "@playwright/test"
