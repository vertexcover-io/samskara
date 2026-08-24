import { readFileSync, writeFileSync } from "node:fs"
import { eq, inArray, sql } from "drizzle-orm"
import type { Db } from "../db/client.js"
import { createDb } from "../db/client.js"
import { orgs, projects, userOrgs, users } from "../db/schema.js"
import type { MessageRow } from "../repositories/messages.repo.js"
import * as messagesRepo from "../repositories/messages.repo.js"
import * as orgsRepo from "../repositories/orgs.repo.js"
import * as projectsRepo from "../repositories/projects.repo.js"
import * as sessionsRepo from "../repositories/sessions.repo.js"
import * as usersRepo from "../repositories/users.repo.js"
import { applyEnv, readEnvValue } from "./env-file.js"
import { mainEnvPath, readMainDatabaseUrl } from "./worktree-env.js"

export const DEV_USER_LOGIN = "samskara-dev"
export const DEV_USER_GITHUB_ID = 900_001
export const DEV_ORG_SLUG = "samskara-dev"
export const DEV_PROJECT_SLUG = "demo"
export const MESSAGES_PER_SESSION = 4

/**
 * Deterministic ids, not random ones: the seed has to be safe to re-run on a database that
 * already holds it, and every upsert here keys off these values to dedupe.
 */
const lineUuid = (session: number, line: number): string =>
  `0000000${session}-0000-4000-8000-${String(line).padStart(12, "0")}`

const SCRIPTS: ReadonlyArray<{ readonly title: string; readonly turns: ReadonlyArray<string> }> = [
  {
    title: "Add pagination to the sessions list",
    turns: [
      "The sessions list loads every row at once. Can we paginate it?",
      "Yes -- I'll add a keyset cursor on (updatedAt, id) so the page stays stable while new sessions arrive.",
      "Does that work with the search filter?",
      "It does. The cursor is applied after the filter, so a filtered page pages through filtered rows only.",
    ],
  },
  {
    title: "Investigate slow project query",
    turns: [
      "The project detail page takes about four seconds to load.",
      "The visibility check runs a subquery per row. I'll fold it into a single join.",
      "Any index needed?",
      "One on userProjectGrant(projectId) -- the join reads it on every request.",
    ],
  },
  {
    title: "Rename the ingest CLI flag",
    turns: [
      "`--path` reads like a single file but it takes a directory.",
      "I'll rename it to `--dir` and keep `--path` as a hidden alias for one release.",
      "Add a deprecation warning?",
      "Yes, printed once to stderr so piped output stays clean.",
    ],
  },
]

const messageRows = (sessionId: string, sessionIndex: number, turns: ReadonlyArray<string>) =>
  turns.map(
    (value, index): MessageRow => ({
      sessionId,
      lineUuid: lineUuid(sessionIndex, index + 1),
      subIndex: 0,
      msgType: "message",
      role: index % 2 === 0 ? "user" : "assistant",
      lineNumber: index + 1,
      source: "claude_code",
      sourceRelativePath: "seed/dev.jsonl",
      model: index % 2 === 0 ? null : "claude-opus-5",
      provider: index % 2 === 0 ? null : "anthropic",
      content: { type: "text", value },
      raw: { type: index % 2 === 0 ? "user" : "assistant", text: value },
      sourceSchemaVersion: 1,
    }),
  )

export type SeedDevSummary = {
  readonly userId: string
  readonly orgSlug: string
  readonly projectId: string
  readonly sessionIds: ReadonlyArray<string>
  readonly messages: number
}

export const seedDev = async (db: Db): Promise<SeedDevSummary> => {
  const user = await usersRepo.upsertByGithubId(db, {
    githubId: DEV_USER_GITHUB_ID,
    githubLogin: DEV_USER_LOGIN,
    email: "dev@samskara.local",
    name: "Samskara Dev",
    avatarUrl: null,
    isSuperAdmin: true,
  })

  await orgsRepo.upsertBySlug(db, DEV_ORG_SLUG, { autoAddMembers: true })
  const org = await orgsRepo.findBySlug(db, DEV_ORG_SLUG)
  if (!org) throw new Error(`org ${DEV_ORG_SLUG} vanished right after upsert`)

  // Inserted rather than synced: `userOrgs.sync` clears memberships this seed did not name, and a
  // dev database may also hold orgs the user joined by logging in for real.
  await db.insert(userOrgs).values({ userId: user.id, orgId: org.id }).onConflictDoNothing()

  const project = await projectsRepo.upsertOwned(db, {
    identity: { name: "Demo Project", slug: DEV_PROJECT_SLUG },
    owner: { kind: "org", orgId: org.id },
  })
  await projectsRepo.grant(db, user.id, project.id, "admin")

  const sessionIds: string[] = []
  let messages = 0
  for (const [index, script] of SCRIPTS.entries()) {
    const id = `dev-session-${index + 1}`
    await sessionsRepo.upsert(db, {
      id,
      source: "claude_code",
      userId: user.id,
      projectId: project.id,
      fields: { title: script.title, startCwd: "/Users/dev/Projects/samskara" },
    })
    await messagesRepo.insertManyIgnoreConflicts(db, id, messageRows(id, index + 1, script.turns))
    sessionIds.push(id)
    messages += script.turns.length
  }

  return { userId: user.id, orgSlug: DEV_ORG_SLUG, projectId: project.id, sessionIds, messages }
}

export type UserSelection =
  | { readonly kind: "all" }
  | { readonly kind: "logins"; readonly logins: ReadonlyArray<string> }

/**
 * Unset means every user, not none. The main checkout's database only ever holds accounts that
 * signed in to this machine's own localhost -- in practice just you -- so copying all of them is
 * what makes a new worktree usable with no extra command after setup. `SEED_USERS` exists to
 * narrow that when a shared database makes sweeping everyone the wrong default.
 */
/** Lets `bun run setup` stay safe to re-run: a database with real projects keeps its own data. */
export const hasProjects = async (db: Db): Promise<boolean> =>
  (await db.select({ id: projects.id }).from(projects).limit(1)).length > 0

export const parseUserSelection = (raw: string | undefined): UserSelection => {
  const logins = (raw ?? "")
    .split(",")
    .map((login) => login.trim().toLowerCase())
    .filter((login) => login.length > 0)
  return logins.length === 0 ? { kind: "all" } : { kind: "logins", logins }
}

const parseSeedUsers = (raw: string | undefined): ReadonlyArray<string> => {
  const selection = parseUserSelection(raw)
  return selection.kind === "all" ? [] : selection.logins
}

export const withSeedUser = (raw: string | undefined, login: string): string => {
  const existing = parseSeedUsers(raw)
  const normalized = login.trim().toLowerCase()
  return existing.includes(normalized) ? existing.join(",") : [...existing, normalized].join(",")
}

export type CopiedUser = {
  readonly githubLogin: string
  readonly sourceId: string
  readonly targetId: string
  /** False when the target already held that github id under a different uuid -- an old cookie
   * carries the source uuid as its `sub`, so it will keep failing until the row is removed. */
  readonly idPreserved: boolean
}

export type CopyUsersResult = {
  readonly copied: ReadonlyArray<CopiedUser>
  readonly missing: ReadonlyArray<string>
}

/**
 * Copies whole rows, uuid included, rather than re-creating users from a github login. The session
 * JWT carries the user's uuid as `sub` and `requireAuth` looks it up in whichever database the
 * worktree points at, so a freshly generated uuid would authenticate as nobody.
 */
export const copyGithubUsers = async (
  source: Db,
  target: Db,
  selection: UserSelection,
): Promise<CopyUsersResult> => {
  const wanted =
    selection.kind === "all"
      ? []
      : selection.logins.map((login) => login.trim().toLowerCase()).filter((l) => l.length > 0)
  if (selection.kind === "logins" && wanted.length === 0) return { copied: [], missing: [] }

  const sourceUsers =
    selection.kind === "all"
      ? await source.select().from(users)
      : await source
          .select()
          .from(users)
          .where(inArray(sql`lower(${users.githubLogin})`, [...wanted]))
  const found = new Set(sourceUsers.map((user) => user.githubLogin.toLowerCase()))
  const missing = wanted.filter((login) => !found.has(login))
  if (sourceUsers.length === 0) return { copied: [], missing }

  await target.insert(users).values(sourceUsers).onConflictDoNothing({ target: users.githubId })
  const landedUsers = await target
    .select()
    .from(users)
    .where(
      inArray(
        users.githubId,
        sourceUsers.map((user) => user.githubId),
      ),
    )
  const targetIdByGithubId = new Map(landedUsers.map((user) => [user.githubId, user.id] as const))

  const sourceUserIds = sourceUsers.map((user) => user.id)
  const memberships = await source
    .select()
    .from(userOrgs)
    .where(inArray(userOrgs.userId, sourceUserIds))
  const orgIds = [...new Set(memberships.map((row) => row.orgId))]
  if (orgIds.length > 0) {
    const sourceOrgs = await source.select().from(orgs).where(inArray(orgs.id, orgIds))
    await target.insert(orgs).values(sourceOrgs).onConflictDoNothing({ target: orgs.githubSlug })
    // Re-read by slug: an org the target already knew keeps its own uuid, and the membership rows
    // have to point at that one, not the source's.
    const landedOrgs = await target
      .select()
      .from(orgs)
      .where(
        inArray(
          orgs.githubSlug,
          sourceOrgs.map((org) => org.githubSlug),
        ),
      )
    const targetOrgIdBySlug = new Map(landedOrgs.map((org) => [org.githubSlug, org.id] as const))
    const slugBySourceOrgId = new Map(sourceOrgs.map((org) => [org.id, org.githubSlug] as const))
    const sourceIdByUserId = new Map(sourceUsers.map((user) => [user.id, user.githubId] as const))

    const rows = memberships.flatMap((row) => {
      const githubId = sourceIdByUserId.get(row.userId)
      const slug = slugBySourceOrgId.get(row.orgId)
      const userId = githubId === undefined ? undefined : targetIdByGithubId.get(githubId)
      const orgId = slug === undefined ? undefined : targetOrgIdBySlug.get(slug)
      return userId && orgId ? [{ userId, orgId }] : []
    })
    if (rows.length > 0) await target.insert(userOrgs).values(rows).onConflictDoNothing()
  }

  // Without a grant the copied user logs in and sees an empty app: the demo project belongs to the
  // seeded org, which a real github account is not a member of.
  const [demo] = await target.select().from(projects).where(eq(projects.slug, DEV_PROJECT_SLUG))
  if (demo) {
    for (const userId of targetIdByGithubId.values()) {
      await projectsRepo.grant(target, userId, demo.id, "admin")
    }
  }

  const copied = sourceUsers.flatMap((user): ReadonlyArray<CopiedUser> => {
    const targetId = targetIdByGithubId.get(user.githubId)
    if (!targetId) return []
    return [
      {
        githubLogin: user.githubLogin,
        sourceId: user.id,
        targetId,
        idPreserved: targetId === user.id,
      },
    ]
  })
  return { copied, missing }
}

const openTarget = () => {
  const url = process.env.DATABASE_URL
  if (!url) {
    console.error("DATABASE_URL is required")
    process.exit(1)
  }
  return { url, ...createDb(url) }
}

const copyFromMainCheckout = async (target: Db, targetUrl: string, selection: UserSelection) => {
  // Locating the main checkout means asking git. Outside a repo -- a CI image, a container build --
  // there is nothing to copy from, and that is not a reason to fail the seed.
  const sourceUrl = ((): string | null => {
    try {
      return readMainDatabaseUrl()
    } catch {
      return null
    }
  })()
  if (!sourceUrl) {
    console.log("no main checkout in reach -- skipping the github user copy")
    return
  }
  if (sourceUrl === targetUrl) {
    console.log("this is the main checkout -- github users are already here")
    return
  }
  const source = createDb(sourceUrl)
  try {
    const result = await copyGithubUsers(source.db, target, selection)
    for (const user of result.copied) {
      const note = user.idPreserved
        ? "same id, your existing session cookie works here"
        : `WARNING: landed as ${user.targetId}, not ${user.sourceId} -- an existing cookie will not`
      console.log(`copied ${user.githubLogin} (${note})`)
    }
    if (result.copied.length === 0) console.log("no github users in the main database yet")
    if (result.missing.length > 0) {
      console.log(`not in the main database, skipped: ${result.missing.join(", ")}`)
    }
  } finally {
    await source.client.end()
  }
}

const addSeedUser = async (login: string): Promise<void> => {
  const target = openTarget()
  try {
    await copyFromMainCheckout(target.db, target.url, { kind: "logins", logins: [login] })
  } finally {
    await target.client.end()
  }
  // Remembered in the main checkout's .env, not this worktree's: that is the file every future
  // worktree is copied from, so recording it once covers every worktree made after this one.
  const envPath = mainEnvPath()
  const text = readFileSync(envPath, "utf8")
  const next = withSeedUser(readEnvValue(text, "SEED_USERS"), login)
  writeFileSync(envPath, applyEnv(text, { SEED_USERS: next }))
  console.log(`SEED_USERS=${next} recorded in ${envPath}`)
}

const USAGE = "usage: bun run seed:dev [--if-empty] | bun run seed:user GITHUB_LOGIN"

const main = async (): Promise<void> => {
  const args = process.argv.slice(2)
  const addUserAt = args.indexOf("--add-user")
  if (addUserAt !== -1) {
    const login = args[addUserAt + 1]
    if (!login) {
      console.error(USAGE)
      process.exit(1)
    }
    await addSeedUser(login)
    return
  }

  const target = openTarget()
  if (args.includes("--if-empty") && (await hasProjects(target.db))) {
    await target.client.end()
    console.log("database already has projects -- leaving it alone")
    return
  }
  const summary = await seedDev(target.db)
  await copyFromMainCheckout(target.db, target.url, parseUserSelection(process.env.SEED_USERS))
  await target.client.end()
  console.log(
    `seeded dev data: org ${summary.orgSlug}, ${summary.sessionIds.length} sessions, ${summary.messages} messages`,
  )
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
