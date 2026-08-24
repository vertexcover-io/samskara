import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { type Db, createDb } from "../db/client.js"
import { orgs } from "../db/schema.js"
import { parseArgs, seedOrg } from "./seed-org.js"

describe("parseArgs", () => {
  test("accepts a bare slug with auto-add on by default", () => {
    expect(parseArgs(["acme"])).toEqual({ ok: true, slug: "acme", autoAddMembers: true })
  })

  test("--no-auto-add turns auto-add off", () => {
    expect(parseArgs(["acme", "--no-auto-add"])).toEqual({
      ok: true,
      slug: "acme",
      autoAddMembers: false,
    })
  })

  test("rejects an unknown flag instead of silently turning auto-add on", () => {
    expect(parseArgs(["acme", "--no-autoadd"]).ok).toBe(false)
    expect(parseArgs(["acme", "--no-auto-add=true"]).ok).toBe(false)
    expect(parseArgs(["acme", "--verbose"]).ok).toBe(false)
  })

  test("rejects when no slug is given", () => {
    expect(parseArgs([]).ok).toBe(false)
    expect(parseArgs(["--no-auto-add"]).ok).toBe(false)
  })
})

const dockerAvailable = () => {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

const packageDir = fileURLToPath(new URL("../..", import.meta.url))

describe.skipIf(!dockerAvailable())("S6: seed:org upserts an org row", () => {
  let container: StartedPostgreSqlContainer
  let teardown: () => Promise<void>
  let db: Db

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg16").start()
    const url = container.getConnectionUri()
    execFileSync("bun", ["run", "db:migrate"], {
      cwd: packageDir,
      env: { ...process.env, DATABASE_URL: url },
      stdio: "inherit",
    })
    const created = createDb(url)
    db = created.db
    teardown = async () => {
      await created.client.end()
      await container.stop()
    }
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
