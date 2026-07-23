import type { Db } from "../db/client.js"
import { createDb } from "../db/client.js"
import * as orgsRepo from "../repositories/orgs.repo.js"

export const seedOrg = (db: Db, githubSlug: string): Promise<void> =>
  orgsRepo.upsertBySlug(db, githubSlug.toLowerCase())

const main = async (): Promise<void> => {
  const slug = process.argv[2]
  if (!slug) {
    console.error("usage: bun run seed:org <github-slug>")
    process.exit(1)
  }
  const url = process.env.DATABASE_URL
  if (!url) {
    console.error("DATABASE_URL is required")
    process.exit(1)
  }
  const { db, client } = createDb(url)
  await seedOrg(db, slug)
  await client.end()
  console.log(`seeded org: ${slug}`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main()
}
