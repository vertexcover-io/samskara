import postgres from "postgres"
import { expect, mintCliToken, test } from "./fixtures/auth.js"
import { API_BASE } from "./playwright.config.js"
import { projectId, seedDatabase } from "./seed.js"

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://samskara:samskara@localhost:5433/samskara"

const SEED = {
  projects: [{ slug: "maya-private", name: "maya-private", owner: "other" as const, sessions: [] }],
  orgMembers: { acme: ["primary" as const] },
}

test.beforeEach(async () => {
  await seedDatabase(SEED)
})

// The route creates a project the seed doesn't know about, so it is not covered by
// seedDatabase's project-id-scoped cleanup and must be removed here explicitly.
test.afterAll(async () => {
  const sql = postgres(DATABASE_URL)
  try {
    await sql`delete from projects where slug = 'acme-widgets' and "ownerOrgId" is not null`
  } finally {
    await sql.end()
  }
})

test("SC25: a member creates the org project once and a foreign projectId is refused", async ({
  request,
}) => {
  const token = await mintCliToken()
  const body = {
    name: "widgets",
    slug: "acme-widgets",
    remote: { host: "github.com", owner: "acme", repoName: "widgets" },
  }

  const first = await request.post(`${API_BASE}/api/projects`, {
    headers: { authorization: `Bearer ${token}` },
    data: body,
  })
  expect(first.status()).toBe(201)
  const firstBody = (await first.json()) as {
    id: string
    owner: { type: string; slug: string }
  }
  expect(firstBody.owner).toEqual({ type: "org", slug: "acme" })

  const second = await request.post(`${API_BASE}/api/projects`, {
    headers: { authorization: `Bearer ${token}` },
    data: body,
  })
  expect(second.status()).toBe(200)
  const secondBody = (await second.json()) as { id: string }
  expect(secondBody.id).toBe(firstBody.id)

  const mayaPrivateId = projectId("maya-private")

  const ingestRes = await request.post(`${API_BASE}/api/ingest`, {
    headers: { authorization: `Bearer ${token}` },
    data: {
      type: "main",
      sessionId: "e2e-sc25-forbidden",
      sourceRelativePath: "e2e-sc25-forbidden.jsonl",
      project: { name: "ignored", slug: "ignored-slug", projectId: mayaPrivateId },
      records: [],
    },
  })
  expect(ingestRes.status()).toBe(403)
  expect(await ingestRes.json()).toEqual({ error: "projectForbidden" })
})
