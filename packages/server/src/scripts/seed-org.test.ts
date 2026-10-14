import { eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import type { Db } from "../db/client.js"
import { orgs } from "../db/schema.js"
import { dockerAvailable, startTestDb } from "../db/testDb.js"
import { parseArgs, seedOrg } from "./seed-org.js"

describe("parseArgs", () => {
  test.each([
    [["acme"], true],
    [["acme", "--no-auto-add"], false],
  ])("accepts %j, setting autoAddMembers to %s", (args, autoAddMembers) => {
    expect(parseArgs(args)).toEqual({ ok: true, slug: "acme", autoAddMembers })
  })

  test.each([
    [["acme", "--no-autoadd"]],
    [["acme", "--no-auto-add=true"]],
    [["acme", "--verbose"]],
    [[]],
    [["--no-auto-add"]],
  ])("rejects %j rather than silently turning auto-add on or seeding no slug", (args) => {
    expect(parseArgs(args).ok).toBe(false)
  })
})

describe.skipIf(!dockerAvailable())("S6: seed:org upserts an org row", () => {
  let teardown: () => Promise<void>
  let db: Db

  beforeAll(async () => {
    const started = await startTestDb()
    db = started.db
    teardown = started.teardown
  }, 120_000)

  afterAll(async () => {
    await teardown?.()
  })

  test("second call for the same slug updates, does not duplicate or throw", async () => {
    await seedOrg(db, "vertexcover-io")
    await seedOrg(db, "vertexcover-io")

    const rows = await db.select().from(orgs).where(eq(orgs.githubSlug, "vertexcover-io"))
    expect(rows).toHaveLength(1)
  })

  test("stores the slug lowercased so it matches getOrgs output", async () => {
    await seedOrg(db, "VertexCover-IO")

    const rows = await db.select().from(orgs).where(eq(orgs.githubSlug, "vertexcover-io"))
    expect(rows).toHaveLength(1)
  })

  test("SC15: sets the flag on by default and --no-auto-add turns it off", async () => {
    await seedOrg(db, "sc15-acme")
    const afterFirst = await db.select().from(orgs).where(eq(orgs.githubSlug, "sc15-acme"))
    expect(afterFirst).toHaveLength(1)
    expect(afterFirst[0]?.autoAddMembers).toBe(true)

    await seedOrg(db, "sc15-acme", { autoAddMembers: false })
    const afterSecond = await db.select().from(orgs).where(eq(orgs.githubSlug, "sc15-acme"))
    expect(afterSecond).toHaveLength(1)
    expect(afterSecond[0]?.autoAddMembers).toBe(false)
  })
})
