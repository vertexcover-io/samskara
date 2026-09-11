import { expect, mintSessionToken, test } from "./fixtures/auth.js"
import { API_BASE } from "./playwright.config.js"
import { E2E_OTHER_USER_ID, seedDatabase } from "./seed.js"

const SESSION_ID = "sessions-api-session"

const SEED = {
  projects: [
    {
      slug: "sessions-api",
      name: "Sessions API",
      sessions: [{ id: SESSION_ID, title: "Captured title" }],
    },
  ],
}

test.beforeEach(async () => {
  await seedDatabase(SEED)
})

test("SC1, SC3: the owner sets a name and description over the real HTTP server, and a later GET returns both beside the captured title", async ({
  request,
}) => {
  const token = await mintSessionToken()

  const patch = await request.fetch(`${API_BASE}/api/sessions/${SESSION_ID}`, {
    method: "PATCH",
    headers: { cookie: `session=${token}` },
    data: { name: "Renamed via API", description: "Set through the PATCH route" },
  })
  expect(patch.status()).toBe(200)
  const patchBody = (await patch.json()) as {
    session: { name: string | null; description: string | null; title: string | null }
  }
  expect(patchBody.session.name).toBe("Renamed via API")
  expect(patchBody.session.description).toBe("Set through the PATCH route")
  expect(patchBody.session.title).toBe("Renamed via API")

  const read = await request.get(`${API_BASE}/api/sessions/${SESSION_ID}`, {
    headers: { cookie: `session=${token}` },
  })
  const readBody = (await read.json()) as {
    session: { name: string | null; title: string | null; aiTitle: string | null }
  }
  expect(readBody.session.name).toBe("Renamed via API")
  expect(readBody.session.title).toBe("Renamed via API")
  expect(readBody.session.aiTitle).toBe("Captured title")
})

test("SC4: a caller with no access to the session's project is told it does not exist, and nothing is stored", async ({
  request,
}) => {
  const strangerToken = await mintSessionToken(E2E_OTHER_USER_ID)

  const patch = await request.fetch(`${API_BASE}/api/sessions/${SESSION_ID}`, {
    method: "PATCH",
    headers: { cookie: `session=${strangerToken}` },
    data: { name: "Hijacked" },
  })

  expect(patch.status()).toBe(404)
  expect(await patch.json()).toEqual({ error: "sessionNotFound" })

  const ownerToken = await mintSessionToken()
  const read = await request.get(`${API_BASE}/api/sessions/${SESSION_ID}`, {
    headers: { cookie: `session=${ownerToken}` },
  })
  const readBody = (await read.json()) as { session: { name: string | null } }
  expect(readBody.session.name).toBeNull()
})
