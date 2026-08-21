import type { Db } from "../db/client.js"
import { createDb } from "../db/client.js"
import * as orgsRepo from "../repositories/orgs.repo.js"

export const seedOrg = (
  db: Db,
  githubSlug: string,
  flags: { readonly autoAddMembers?: boolean } = {},
): Promise<void> =>
  orgsRepo.upsertBySlug(db, githubSlug.toLowerCase(), {
    autoAddMembers: flags.autoAddMembers ?? true,
  })

const main = async (): Promise<void> => {
  const args = process.argv.slice(2)
  const slug = args.find((arg) => !arg.startsWith("--"))
  if (!slug) {
    console.error("usage: bun run seed:org <github-slug> [--no-auto-add]")
    process.exit(1)
  }
  const url = process.env.DATABASE_URL
  if (!url) {
    console.error("DATABASE_URL is required")
    process.exit(1)
  }
  const autoAddMembers = !args.includes("--no-auto-add")
  const { db, client } = createDb(url)
  await seedOrg(db, slug, { autoAddMembers })
  await client.end()
  console.log(`seeded org: ${slug} (autoAddMembers: ${autoAddMembers})`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main()
}
