import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { and, eq, sql } from "drizzle-orm"
import type { Sql } from "postgres"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import type { Db } from "./client.js"
import {
  commits,
  messages,
  orgs,
  projects,
  pullRequests,
  repos,
  sessionPullRequests,
  sessions,
  userOrgs,
  users,
} from "./schema.js"
import { dockerAvailable, startTestDb } from "./testDb.js"

describe.skipIf(!dockerAvailable())("repo ownership backfill", () => {
  let teardown: () => Promise<void>
  let db: Db
  let client: Sql

  beforeAll(async () => {
    const started = await startTestDb()
    db = started.db
    client = started.client
    teardown = started.teardown
  }, 120_000)

  afterAll(async () => {
    await teardown?.()
  })

  // The migration itself, replayed against rows seeded after it first ran. Its statements share one
  // transaction because `repo_merge` is a temporary table dropped on commit.
  const migration = readFileSync(
    new URL("../../migrations/0024_repo_ownership_backfill.sql", import.meta.url),
    "utf8",
  )
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0)

  const run = () =>
    client.begin(async (tx) => {
      for (const statement of migration) await tx.unsafe(statement)
    })

  // Rows differing only by case can exist only before 0025 builds the folded index, so a test that
  // seeds them reopens that window. Rebuilding the index afterwards is the assertion that matters:
  // it is 0025 itself, and it fails if the merge left a duplicate behind.
  const buildFoldedIndexes = readFileSync(
    new URL("../../migrations/0025_useful_nuke.sql", import.meta.url),
    "utf8",
  )
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.startsWith("CREATE"))

  const dropFoldedIndexes = async () => {
    await client.unsafe('drop index "repos_identity_owner_user_unique"')
    await client.unsafe('drop index "repos_identity_owner_org_unique"')
  }
  const rebuildFoldedIndexes = async () => {
    for (const statement of buildFoldedIndexes) await client.unsafe(statement)
  }

  let userCounter = 0
  const seedUser = async () => {
    userCounter += 1
    const [user] = await db
      .insert(users)
      .values({ githubId: 800_000 + userCounter, githubLogin: `backfill-user-${userCounter}` })
      .returning()
    if (!user) throw new Error("seed user failed")
    return user
  }

  let orgCounter = 0
  const seedOrg = async (slug?: string) => {
    orgCounter += 1
    const [org] = await db
      .insert(orgs)
      .values({ githubSlug: slug ?? `backfill-org-${orgCounter}` })
      .returning()
    if (!org) throw new Error("seed org failed")
    return org
  }

  const seedMembership = (userId: string, orgId: string) =>
    db.insert(userOrgs).values({ userId, orgId })

  let projectCounter = 0
  const seedProject = async (
    name: string,
    owner: { readonly ownerUserId?: string; readonly ownerOrgId?: string },
  ) => {
    projectCounter += 1
    const [project] = await db
      .insert(projects)
      .values({ name, slug: `backfill-project-${projectCounter}`, ...owner })
      .returning()
    if (!project) throw new Error("seed project failed")
    return project
  }

  const seedRepo = async (
    owner: string,
    repoName: string,
    ownerRef: { readonly ownerUserId?: string; readonly ownerOrgId?: string },
    host = "github.com",
  ) => {
    const [repo] = await db
      .insert(repos)
      .values({ host, owner, repoName, ...ownerRef })
      .returning()
    if (!repo) throw new Error("seed repo failed")
    return repo
  }

  let sessionCounter = 0
  const seedSession = async (projectId: string, userId: string) => {
    sessionCounter += 1
    const id = `backfill-sess-${sessionCounter}`
    await db.insert(sessions).values({ id, source: "claude_code", userId, projectId })
    return id
  }

  let lineNumber = 0
  const seedMessage = async (sessionId: string, repoId: string) => {
    lineNumber += 1
    const [message] = await db
      .insert(messages)
      .values({
        sessionId,
        lineUuid: randomUUID(),
        subIndex: 0,
        msgType: "message",
        lineNumber,
        raw: {},
        sourceSchemaVersion: 1,
        repoId,
      })
      .returning()
    if (!message) throw new Error("seed message failed")
    return message
  }

  test("SC12: two user-owned rows for one org repo collapse to one org-owned row, with history repointed", async () => {
    const org = await seedOrg("sc12-org")
    const alice = await seedUser()
    const bob = await seedUser()
    await seedMembership(alice.id, org.id)
    await seedMembership(bob.id, org.id)
    const project = await seedProject("sc12-app", { ownerOrgId: org.id })

    const aliceRepo = await seedRepo("sc12-org", "widget", { ownerUserId: alice.id })
    const bobRepo = await seedRepo("sc12-org", "widget", { ownerUserId: bob.id })

    const aliceSession = await seedSession(project.id, alice.id)
    const bobSession = await seedSession(project.id, bob.id)
    const aliceMessage = await seedMessage(aliceSession, aliceRepo.id)
    const bobMessage = await seedMessage(bobSession, bobRepo.id)
    const [aliceCommit] = await db
      .insert(commits)
      .values({ repoId: aliceRepo.id, sha: "aaaa111", sessionId: aliceSession })
      .returning()
    const [bobPr] = await db
      .insert(pullRequests)
      .values({ repoId: bobRepo.id, number: 7 })
      .returning()
    if (!aliceCommit || !bobPr) throw new Error("seed commit/pr failed")

    await run()

    const survivors = await db.select().from(repos).where(eq(repos.repoName, "widget"))
    expect(survivors).toHaveLength(1)
    const survivor = survivors[0]
    if (!survivor) throw new Error("no survivor row")
    expect(survivor.ownerOrgId).toBe(org.id)
    expect(survivor.ownerUserId).toBeNull()

    const [aliceMessageAfter] = await db
      .select()
      .from(messages)
      .where(eq(messages.id, aliceMessage.id))
    const [bobMessageAfter] = await db.select().from(messages).where(eq(messages.id, bobMessage.id))
    expect(aliceMessageAfter?.repoId).toBe(survivor.id)
    expect(bobMessageAfter?.repoId).toBe(survivor.id)

    const [commitAfter] = await db.select().from(commits).where(eq(commits.id, aliceCommit.id))
    const [prAfter] = await db.select().from(pullRequests).where(eq(pullRequests.id, bobPr.id))
    expect(commitAfter?.repoId).toBe(survivor.id)
    expect(prAfter?.repoId).toBe(survivor.id)
  })

  test("R8: a repo under an org's name, captured by a member, becomes that org's", async () => {
    const org = await seedOrg("r8-org")
    const alice = await seedUser()
    await seedMembership(alice.id, org.id)
    const repo = await seedRepo("r8-org", "thingummy", { ownerUserId: alice.id })
    const project = await seedProject("thingummy", { ownerOrgId: org.id })
    const session = await seedSession(project.id, alice.id)
    await seedMessage(session, repo.id)

    await run()

    const [after] = await db.select().from(repos).where(eq(repos.id, repo.id))
    expect(after).toMatchObject({ ownerOrgId: org.id, ownerUserId: null })
  })

  test("SC13: a repo under nobody's org name stays with whoever captured it", async () => {
    await seedOrg("sc13-org")
    const bob = await seedUser()
    const repo = await seedRepo("sc13-nobody", "solo-project", { ownerUserId: bob.id })
    const project = await seedProject("solo-project", { ownerUserId: bob.id })
    const session = await seedSession(project.id, bob.id)
    await seedMessage(session, repo.id)

    await run()

    const [after] = await db.select().from(repos).where(eq(repos.id, repo.id))
    expect(after).toMatchObject({ ownerUserId: bob.id, ownerOrgId: null })
  })

  test("SC14: a repo under an org's name stays with a capturer who is not a member", async () => {
    const org = await seedOrg("sc14-org")
    const outsider = await seedUser()
    const repo = await seedRepo("sc14-org", "gadget", { ownerUserId: outsider.id })
    // The outsider captured it into their own project; belonging to the org is what would hand it
    // over, and they do not.
    const project = await seedProject("gadget", { ownerUserId: outsider.id })
    const session = await seedSession(project.id, outsider.id)
    await seedMessage(session, repo.id)

    await run()

    const [after] = await db.select().from(repos).where(eq(repos.id, repo.id))
    expect(after).toMatchObject({ ownerUserId: outsider.id, ownerOrgId: null })
    expect(org.id).toBeTruthy()
  })

  test("SC15: the backfill is idempotent and links each project to its backing or dominant repo", async () => {
    const org = await seedOrg("sc15-org")
    const alice = await seedUser()
    await seedMembership(alice.id, org.id)

    // A project whose backing repo (name match) exists -- the primary tier.
    const namedProject = await seedProject("named-app", { ownerOrgId: org.id })
    const namedRepo = await seedRepo("sc15-org", "named-app", { ownerUserId: alice.id })
    const namedSession = await seedSession(namedProject.id, alice.id)
    await seedMessage(namedSession, namedRepo.id)

    // A personal project whose name matches no repo -- falls back to its dominant repo. It has to
    // be personal: an org project is given a repo named after it, which the named tier then wins.
    const fallbackProject = await seedProject("fallback-app", { ownerUserId: alice.id })
    const repoA = await seedRepo("sc15-org", "lib-a", { ownerUserId: alice.id })
    const repoB = await seedRepo("sc15-org", "lib-b", { ownerUserId: alice.id })
    const fallbackSession = await seedSession(fallbackProject.id, alice.id)
    await seedMessage(fallbackSession, repoA.id)
    await seedMessage(fallbackSession, repoA.id)
    await seedMessage(fallbackSession, repoB.id)

    await run()
    const reposAfterFirst = await db.select().from(repos).orderBy(repos.id)
    const projectsAfterFirst = await db.select().from(projects).orderBy(projects.id)

    await run()
    const reposAfterSecond = await db.select().from(repos).orderBy(repos.id)
    const projectsAfterSecond = await db.select().from(projects).orderBy(projects.id)
    expect(reposAfterSecond).toEqual(reposAfterFirst)
    expect(projectsAfterSecond).toEqual(projectsAfterFirst)

    const [namedProjectAfter] = await db
      .select()
      .from(projects)
      .where(eq(projects.id, namedProject.id))
    const [namedRepoAfter] = await db.select().from(repos).where(eq(repos.id, namedRepo.id))
    expect(namedProjectAfter?.repoId).toBe(namedRepoAfter?.id)

    const [fallbackProjectAfter] = await db
      .select()
      .from(projects)
      .where(eq(projects.id, fallbackProject.id))
    expect(fallbackProjectAfter?.repoId).toBe(repoA.id)
  })

  test("SC20: an org project whose repo was never captured is given one and linked to it", async () => {
    const org = await seedOrg("sc20-org")
    const alice = await seedUser()
    await seedMembership(alice.id, org.id)
    // An org project always came from a github.com remote whose owner is the org and whose repo
    // name is the project name, so the repo it stands for is known even with no row for it.
    const project = await seedProject("widgetry", { ownerOrgId: org.id })
    const other = await seedRepo("sc20-org", "sidecar", { ownerUserId: alice.id })
    const session = await seedSession(project.id, alice.id)
    await seedMessage(session, other.id)

    await run()

    const [made] = await db
      .select()
      .from(repos)
      .where(and(eq(repos.repoName, "widgetry"), eq(repos.ownerOrgId, org.id)))
    expect(made).toMatchObject({ host: "github.com", owner: "sc20-org", ownerUserId: null })
    const [after] = await db.select().from(projects).where(eq(projects.id, project.id))
    expect(after?.repoId).toBe(made?.id)
  })

  test("SC21: a repo nothing points at is deleted, and one a project points at is kept", async () => {
    const alice = await seedUser()
    const orphan = await seedRepo("sc21-org", "abandoned", { ownerUserId: alice.id })
    const kept = await seedRepo("sc21-org", "still-used", { ownerUserId: alice.id })
    const project = await seedProject("still-used", { ownerUserId: alice.id })
    const session = await seedSession(project.id, alice.id)
    await seedMessage(session, kept.id)

    await run()

    const [orphanAfter] = await db.select().from(repos).where(eq(repos.id, orphan.id))
    const [keptAfter] = await db.select().from(repos).where(eq(repos.id, kept.id))
    expect(orphanAfter).toBeUndefined()
    expect(keptAfter?.id).toBe(kept.id)
  })

  test("SC17: a git-backed project links to its named repo, not the sub-repo its sessions touched more", async () => {
    const org = await seedOrg("sc17-acme")
    const alice = await seedUser()
    await seedMembership(alice.id, org.id)

    const project = await seedProject("app", { ownerOrgId: org.id })
    const appRepo = await seedRepo("sc17-acme", "app", { ownerUserId: alice.id })
    const libRepo = await seedRepo("sc17-acme", "lib", { ownerUserId: alice.id })

    const session = await seedSession(project.id, alice.id)
    await seedMessage(session, appRepo.id)
    await seedMessage(session, libRepo.id)
    await seedMessage(session, libRepo.id)
    await seedMessage(session, libRepo.id)

    await run()

    const [projectAfter] = await db.select().from(projects).where(eq(projects.id, project.id))
    const [appRepoAfter] = await db.select().from(repos).where(eq(repos.id, appRepo.id))
    expect(projectAfter?.repoId).toBe(appRepoAfter?.id)
  })

  test("R3 (verification bug): repo rows that differ only in casing collapse to one, history intact", async () => {
    await dropFoldedIndexes()
    const alice = await seedUser()
    const mixed = await seedRepo("Acme-Cased", "Gizmo", { ownerUserId: alice.id })
    const lower = await seedRepo("acme-cased", "gizmo", { ownerUserId: alice.id })

    const project = await seedProject("cased-app", { ownerUserId: alice.id })
    const session = await seedSession(project.id, alice.id)
    const mixedMessage = await seedMessage(session, mixed.id)
    const [mixedCommit] = await db
      .insert(commits)
      .values({ repoId: mixed.id, sha: "cased01", sessionId: session })
      .returning()
    if (!mixedCommit) throw new Error("seed commit failed")

    await run()
    await rebuildFoldedIndexes()

    const rows = await db.select().from(repos).where(sql`lower(${repos.repoName}) = 'gizmo'`)
    expect(rows).toHaveLength(1)
    const survivor = rows[0]
    if (!survivor) throw new Error("no survivor row")
    expect([mixed.id, lower.id]).toContain(survivor.id)

    const [messageAfter] = await db.select().from(messages).where(eq(messages.id, mixedMessage.id))
    const [commitAfter] = await db.select().from(commits).where(eq(commits.id, mixedCommit.id))
    expect(messageAfter?.repoId).toBe(survivor.id)
    expect(commitAfter?.repoId).toBe(survivor.id)
  })

  test("xhawk-1: merging repos that share a commit sha and a PR number does not abort the migration", async () => {
    await dropFoldedIndexes()
    const alice = await seedUser()
    // Two rows for one real repository -- so they carry the same commit and the same PR, which is
    // exactly what `commits_repo_sha_unique` and `pullRequests_repo_number_unique` forbid on one row.
    const mixed = await seedRepo("Collide-Org", "Doodad", { ownerUserId: alice.id })
    const lower = await seedRepo("collide-org", "doodad", { ownerUserId: alice.id })

    const project = await seedProject("collide-app", { ownerUserId: alice.id })
    const session = await seedSession(project.id, alice.id)
    for (const repoId of [mixed.id, lower.id]) {
      await db.insert(commits).values({ repoId, sha: "deadbee", sessionId: session })
      const [pr] = await db.insert(pullRequests).values({ repoId, number: 42 }).returning()
      if (!pr) throw new Error("seed pr failed")
      await db.insert(sessionPullRequests).values({ sessionId: session, prId: pr.id })
    }

    await run()
    await rebuildFoldedIndexes()

    const rows = await db.select().from(repos).where(sql`lower(${repos.repoName}) = 'doodad'`)
    expect(rows).toHaveLength(1)
    const survivor = rows[0]
    if (!survivor) throw new Error("no survivor row")

    const survivingCommits = await db.select().from(commits).where(eq(commits.repoId, survivor.id))
    const survivingPrs = await db
      .select()
      .from(pullRequests)
      .where(eq(pullRequests.repoId, survivor.id))
    expect(survivingCommits).toHaveLength(1)
    expect(survivingPrs).toHaveLength(1)
    expect(survivingCommits[0]?.sha).toBe("deadbee")
    expect(survivingPrs[0]?.number).toBe(42)

    // The session keeps its link to the surviving pull request rather than losing it with the row.
    const links = await db
      .select()
      .from(sessionPullRequests)
      .where(eq(sessionPullRequests.prId, survivingPrs[0]?.id as string))
    expect(links).toHaveLength(1)
  })

  test("xhawk-2: ownership follows the repo, so an org repo in a personal project is still the org's", async () => {
    const org = await seedOrg("xhawk2-org")
    const alice = await seedUser()
    await seedMembership(alice.id, org.id)

    // Captured into Alice's own project, but the repo sits under the org she belongs to. The
    // project it was captured in does not decide who owns it.
    const repo = await seedRepo("xhawk2-org", "personal-take", { ownerUserId: alice.id })
    const project = await seedProject("personal-take", { ownerUserId: alice.id })
    const session = await seedSession(project.id, alice.id)
    await seedMessage(session, repo.id)

    await run()

    const [after] = await db.select().from(repos).where(eq(repos.id, repo.id))
    expect(after).toMatchObject({ ownerOrgId: org.id, ownerUserId: null })
  })

  test("R3: a repo keeps the spelling it was stored with", async () => {
    const alice = await seedUser()
    const local = await seedRepo(
      "/Users/Maya/Projects/Thing",
      "Thing",
      { ownerUserId: alice.id },
      "local",
    )
    const project = await seedProject("Thing", { ownerUserId: alice.id })
    const session = await seedSession(project.id, alice.id)
    await seedMessage(session, local.id)

    await run()

    const [after] = await db.select().from(repos).where(eq(repos.id, local.id))
    expect(after?.owner).toBe("/Users/Maya/Projects/Thing")
    expect(after?.repoName).toBe("Thing")
  })

  test("SC18: a project whose name matches a repo on two hosts links to the github.com one", async () => {
    const org = await seedOrg("sc18-org")
    const project = await seedProject("tool", { ownerOrgId: org.id })
    const onGithub = await seedRepo("sc18-org", "tool", { ownerOrgId: org.id })
    await seedRepo("sc18-org", "tool", { ownerOrgId: org.id }, "gitlab.com")

    await run()

    const [projectAfter] = await db.select().from(projects).where(eq(projects.id, project.id))
    expect(projectAfter?.repoId).toBe(onGithub.id)
  })

  test("SC19: with no github.com candidate the named-repo tier abstains and the dominant repo decides", async () => {
    const org = await seedOrg("sc19-org")
    const alice = await seedUser()
    await seedMembership(alice.id, org.id)
    const project = await seedProject("kit", { ownerUserId: alice.id })

    // Two same-named candidates, neither on github.com: the preference cannot narrow them to one.
    await seedRepo("sc19-org", "kit", { ownerUserId: alice.id }, "gitlab.com")
    const onBitbucket = await seedRepo(
      "sc19-org",
      "kit",
      { ownerUserId: alice.id },
      "bitbucket.org",
    )

    const session = await seedSession(project.id, alice.id)
    await seedMessage(session, onBitbucket.id)

    await run()

    const [projectAfter] = await db.select().from(projects).where(eq(projects.id, project.id))
    expect(projectAfter?.repoId).toBe(onBitbucket.id)
  })
})
