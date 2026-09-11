import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { eq, inArray } from "drizzle-orm"
import type { Db } from "../db/client.js"
import { createDb } from "../db/client.js"
import { orgs, projects, userOrgs, users } from "../db/schema.js"
import type { MessageRow } from "../repositories/messages.repo.js"
import * as messagesRepo from "../repositories/messages.repo.js"
import * as orgsRepo from "../repositories/orgs.repo.js"
import * as projectsRepo from "../repositories/projects.repo.js"
import * as sessionsRepo from "../repositories/sessions.repo.js"
import * as usersRepo from "../repositories/users.repo.js"

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

/** Lets `bun run setup` stay safe to re-run: a database with real projects keeps its own data. */
export const hasProjects = async (db: Db): Promise<boolean> =>
  (await db.select({ id: projects.id }).from(projects).limit(1)).length > 0

export type CopiedUser = {
  readonly githubLogin: string
  readonly sourceId: string
  readonly targetId: string
  /** False when the target already held that github id under a different uuid -- an old cookie
   * carries the source uuid as its `sub`, so it will keep failing until the row is removed. */
  readonly idPreserved: boolean
}

export type CopyUsersResult = { readonly copied: ReadonlyArray<CopiedUser> }

const SNAPSHOT_VERSION = 1

type SnapshotUser = {
  readonly id: string
  readonly githubId: number
  readonly githubLogin: string
  readonly email?: string | null
  readonly name?: string | null
  readonly avatarUrl?: string | null
  readonly isSuperAdmin: boolean
}

type SnapshotOrg = {
  readonly id: string
  readonly githubOrgId?: number | null
  readonly githubSlug: string
  readonly name?: string | null
  readonly autoAddMembers: boolean
}

/**
 * Memberships name their ends by github id and org slug rather than uuid. Those are the same in
 * every database, so restoring never has to guess which local uuid a foreign one meant.
 */
type SnapshotMembership = { readonly userGithubId: number; readonly orgSlug: string }

export type IdentitySnapshot = {
  readonly version: number
  readonly users: ReadonlyArray<SnapshotUser>
  readonly orgs: ReadonlyArray<SnapshotOrg>
  readonly memberships: ReadonlyArray<SnapshotMembership>
}

/**
 * Timestamps are left out on purpose: they carry no meaning for a dev fixture, and keeping them
 * would mean reviving Date objects out of JSON on every restore.
 */
export const captureIdentity = async (db: Db): Promise<IdentitySnapshot> => {
  const allUsers = (await db.select().from(users)).filter(
    (user) => user.githubId !== DEV_USER_GITHUB_ID,
  )
  const allOrgs = (await db.select().from(orgs)).filter((org) => org.githubSlug !== DEV_ORG_SLUG)
  const links = await db.select().from(userOrgs)

  const loginById = new Map(allUsers.map((user) => [user.id, user.githubId] as const))
  const slugById = new Map(allOrgs.map((org) => [org.id, org.githubSlug] as const))

  return {
    version: SNAPSHOT_VERSION,
    users: allUsers.map((user) => ({
      id: user.id,
      githubId: user.githubId,
      githubLogin: user.githubLogin,
      email: user.email,
      name: user.name,
      avatarUrl: user.avatarUrl,
      isSuperAdmin: user.isSuperAdmin,
    })),
    orgs: allOrgs.map((org) => ({
      id: org.id,
      githubOrgId: org.githubOrgId,
      githubSlug: org.githubSlug,
      name: org.name,
      autoAddMembers: org.autoAddMembers,
    })),
    memberships: links.flatMap((link) => {
      const userGithubId = loginById.get(link.userId)
      const orgSlug = slugById.get(link.orgId)
      return userGithubId !== undefined && orgSlug !== undefined ? [{ userGithubId, orgSlug }] : []
    }),
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

/** Returns null rather than throwing: a bad snapshot must not take the whole seed down with it. */
export const parseSnapshot = (text: string): IdentitySnapshot | null => {
  const parsed: unknown = (() => {
    try {
      return JSON.parse(text)
    } catch {
      return null
    }
  })()
  if (!isRecord(parsed)) return null
  if (parsed.version !== SNAPSHOT_VERSION) return null
  if (!Array.isArray(parsed.users) || !Array.isArray(parsed.orgs)) return null
  if (!Array.isArray(parsed.memberships)) return null
  return parsed as unknown as IdentitySnapshot
}

/**
 * Inserts whole rows, uuid included, rather than re-creating users from a github login. The session
 * JWT carries the user's uuid as `sub` and `requireAuth` looks it up in whichever database the
 * worktree points at, so a freshly generated uuid would authenticate as nobody.
 */
export const restoreIdentity = async (
  target: Db,
  snapshot: IdentitySnapshot,
): Promise<CopyUsersResult> => {
  if (snapshot.users.length === 0) return { copied: [] }

  await target
    .insert(users)
    .values(snapshot.users.map((user) => ({ ...user })))
    .onConflictDoNothing({ target: users.githubId })
  const landedUsers = await target
    .select()
    .from(users)
    .where(
      inArray(
        users.githubId,
        snapshot.users.map((user) => user.githubId),
      ),
    )
  const userIdByGithubId = new Map(landedUsers.map((user) => [user.githubId, user.id] as const))

  if (snapshot.orgs.length > 0) {
    await target
      .insert(orgs)
      .values(snapshot.orgs.map((org) => ({ ...org })))
      .onConflictDoNothing({ target: orgs.githubSlug })
  }
  // Read back by slug: an org the target already knew keeps its own uuid, and the membership rows
  // have to point at that one, not the snapshot's.
  const landedOrgs =
    snapshot.orgs.length === 0
      ? []
      : await target
          .select()
          .from(orgs)
          .where(
            inArray(
              orgs.githubSlug,
              snapshot.orgs.map((org) => org.githubSlug),
            ),
          )
  const orgIdBySlug = new Map(landedOrgs.map((org) => [org.githubSlug, org.id] as const))

  const links = snapshot.memberships.flatMap((membership) => {
    const userId = userIdByGithubId.get(membership.userGithubId)
    const orgId = orgIdBySlug.get(membership.orgSlug)
    return userId && orgId ? [{ userId, orgId }] : []
  })
  if (links.length > 0) await target.insert(userOrgs).values(links).onConflictDoNothing()

  // Joined to the dev org as well as their own: otherwise the org switcher lists one org and
  // anything scoped to the seeded org reads as empty for a real github account.
  const devOrg = await orgsRepo.findBySlug(target, DEV_ORG_SLUG)
  if (devOrg) {
    const devLinks = [...userIdByGithubId.values()].map((userId) => ({ userId, orgId: devOrg.id }))
    if (devLinks.length > 0) await target.insert(userOrgs).values(devLinks).onConflictDoNothing()
  }

  // Without a grant the restored user logs in and sees an empty app: the demo project belongs to
  // the seeded org, which a real github account is not a member of.
  const [demo] = await target.select().from(projects).where(eq(projects.slug, DEV_PROJECT_SLUG))
  if (demo) {
    for (const userId of userIdByGithubId.values()) {
      await projectsRepo.grant(target, userId, demo.id, "admin")
    }
  }

  const copied = snapshot.users.flatMap((user): ReadonlyArray<CopiedUser> => {
    const targetId = userIdByGithubId.get(user.githubId)
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
  return { copied }
}

const openTarget = () => {
  const url = process.env.DATABASE_URL
  if (!url) {
    console.error("DATABASE_URL is required")
    process.exit(1)
  }
  return createDb(url)
}

export const DEFAULT_SNAPSHOT_PATH = ".seed/identity.json"

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..")

const resolveSnapshotPath = (given: string | undefined): string =>
  given ? resolve(given) : join(repoRoot, DEFAULT_SNAPSHOT_PATH)

const flagValue = (args: ReadonlyArray<string>, flag: string): string | undefined => {
  const at = args.indexOf(flag)
  return at === -1 ? undefined : args[at + 1]
}

const restoreFromFile = async (target: Db, path: string): Promise<void> => {
  if (!existsSync(path)) {
    console.log(`no identity snapshot at ${path} -- run \`bun run seed:capture\` to make one`)
    return
  }
  const snapshot = parseSnapshot(readFileSync(path, "utf8"))
  if (!snapshot) {
    console.log(`ignoring ${path}: not a snapshot this version understands`)
    return
  }
  const { copied } = await restoreIdentity(target, snapshot)
  for (const user of copied) {
    if (user.idPreserved) console.log(`restored ${user.githubLogin}`)
    else
      console.log(
        `restored ${user.githubLogin} -- WARNING: new id, an existing cookie will not work`,
      )
  }
  if (copied.length === 0) console.log(`${path} holds no users`)
}

/** Writes nothing when there is nobody real to write: an empty snapshot is just noise in a worktree. */
export const captureToFile = async (db: Db, path: string): Promise<number> => {
  const snapshot = await captureIdentity(db)
  if (snapshot.users.length === 0) return 0
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(snapshot, null, 2)}\n`)
  return snapshot.users.length
}

const capture = async (args: ReadonlyArray<string>): Promise<void> => {
  const target = openTarget()
  const path = resolveSnapshotPath(flagValue(args, "--to"))
  const count = await captureToFile(target.db, path)
  await target.client.end()
  if (count === 0) console.log("no github users to capture yet -- sign in first")
  else console.log(`captured ${count} user${count === 1 ? "" : "s"} to ${path}`)
}

const seed = async (args: ReadonlyArray<string>): Promise<void> => {
  const target = openTarget()
  if (args.includes("--if-empty") && (await hasProjects(target.db))) {
    await target.client.end()
    console.log("database already has projects -- leaving it alone")
    return
  }
  const summary = await seedDev(target.db)
  await restoreFromFile(target.db, resolveSnapshotPath(flagValue(args, "--from")))
  await target.client.end()
  console.log(
    `seeded dev data: org ${summary.orgSlug}, ${summary.sessionIds.length} sessions, ${summary.messages} messages`,
  )
}

const main = async (): Promise<void> => {
  const args = process.argv.slice(2)
  await (args.includes("--capture") ? capture(args) : seed(args))
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
