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

const USAGE = "usage: bun run seed:org <github-slug> [--no-auto-add]"

export type ParsedArgs =
  | { readonly ok: true; readonly slug: string; readonly autoAddMembers: boolean }
  | { readonly ok: false; readonly message: string }

/**
 * Any `--`-prefixed argument other than the exact flag we recognize is rejected rather than
 * silently ignored: `--no-autoadd` or `--no-auto-add=true` used to parse as "auto-add ON" --
 * the opposite of what the caller typed.
 */
export const parseArgs = (args: ReadonlyArray<string>): ParsedArgs => {
  const flags = args.filter((arg) => arg.startsWith("--"))
  if (flags.some((flag) => flag !== "--no-auto-add")) return { ok: false, message: USAGE }
  const slug = args.find((arg) => !arg.startsWith("--"))
  if (!slug) return { ok: false, message: USAGE }
  return { ok: true, slug, autoAddMembers: !flags.includes("--no-auto-add") }
}

const main = async (): Promise<void> => {
  const parsed = parseArgs(process.argv.slice(2))
  if (!parsed.ok) {
    console.error(parsed.message)
    process.exit(1)
  }
  const url = process.env.DATABASE_URL
  if (!url) {
    console.error("DATABASE_URL is required")
    process.exit(1)
  }
  const { db, client } = createDb(url)
  await seedOrg(db, parsed.slug, { autoAddMembers: parsed.autoAddMembers })
  await client.end()
  console.log(`seeded org: ${parsed.slug} (autoAddMembers: ${parsed.autoAddMembers})`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main()
}
