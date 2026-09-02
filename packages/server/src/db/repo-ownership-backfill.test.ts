import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import { eq } from "drizzle-orm"
import type { Sql } from "postgres"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { createDb, type Db } from "./client.js"
import { hasWork, repoOwnershipBackfillStep } from "./repoOwnershipBackfill.js"
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

const dockerAvailable = (): boolean => {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

const packageDir = fileURLToPath(new URL("../..", import.meta.url))

describe.skipIf(!dockerAvailable())("repo ownership backfill", () => {
  let container: StartedPostgreSqlContainer
  let teardown: () => Promise<void>
  let db: Db
  let client: Sql

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
    client = created.client
    teardown = async () => {
      await created.client.end()
      await container.stop()
    }
  }, 120_000)

  afterAll(async () => {
    await teardown?.()
  })

  const run = () => repoOwnershipBackfillStep.run({ client, flags: new Set() })
  const verify = () => repoOwnershipBackfillStep.verify({ client, flags: new Set() })

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

  test("R8: an org registered under a mixed-case slug still claims its repos", async () => {
    // `orgs.githubSlug` has no lowercase constraint, and the snapshot restore behind `bun run
    // seed` inserts it verbatim -- so the org side of the match has to fold case too, not just
    // the repo side.
    const org = await seedOrg("Mixed-Case-Org")
    const alice = await seedUser()
    await seedMembership(alice.id, org.id)
    const repo = await seedRepo("mixed-case-org", "thingummy", { ownerUserId: alice.id })

    await run()

    const [after] = await db.select().from(repos).where(eq(repos.id, repo.id))
    expect(after).toMatchObject({ ownerOrgId: org.id, ownerUserId: null })
  })

  test("SC13: a personal repo whose owner is not a registered org stays user-owned", async () => {
    const user = await seedUser()
    const repo = await seedRepo("sc13-nobody", "solo-project", { ownerUserId: user.id })

    await run()

    const [after] = await db.select().from(repos).where(eq(repos.id, repo.id))
    expect(after?.ownerUserId).toBe(user.id)
    expect(after?.ownerOrgId).toBeNull()
  })

  test("SC14: a repo named after a registered org stays user-owned when the owner-user is not a member", async () => {
    await seedOrg("sc14-org")
    const outsider = await seedUser()
    const repo = await seedRepo("sc14-org", "gadget", { ownerUserId: outsider.id })

    await run()

    const [after] = await db.select().from(repos).where(eq(repos.id, repo.id))
    expect(after?.ownerUserId).toBe(outsider.id)
    expect(after?.ownerOrgId).toBeNull()
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

    // A project with no named-repo match -- falls back to the dominant repo across its sessions.
    const fallbackProject = await seedProject("fallback-app", { ownerOrgId: org.id })
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

    await expect(verify()).resolves.not.toThrow()
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

  test("R3 (verification bug): repo rows that differ only in casing collapse to one lowercase row, history intact", async () => {
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

    const rows = await db.select().from(repos).where(eq(repos.repoName, "gizmo"))
    expect(rows).toHaveLength(1)
    const survivor = rows[0]
    if (!survivor) throw new Error("no survivor row")
    expect(survivor.owner).toBe("acme-cased")
    expect([mixed.id, lower.id]).toContain(survivor.id)

    const [messageAfter] = await db.select().from(messages).where(eq(messages.id, mixedMessage.id))
    const [commitAfter] = await db.select().from(commits).where(eq(commits.id, mixedCommit.id))
    expect(messageAfter?.repoId).toBe(survivor.id)
    expect(commitAfter?.repoId).toBe(survivor.id)

    await verify()
  })

  test("R3: verify rejects a forge repo still spelled with its remote's casing, before run fixes it", async () => {
    const alice = await seedUser()
    const uncanonical = await seedRepo("Verify-Cased", "Doohickey", { ownerUserId: alice.id })

    // `verify` is what backs `db:verify`, so it has to detect the unconverged row on its own --
    // not merely agree with `run` after `run` has already fixed everything.
    await expect(verify()).rejects.toThrow(/casing/)

    await run()
    await expect(verify()).resolves.toBeUndefined()
    const [after] = await db.select().from(repos).where(eq(repos.id, uncanonical.id))
    expect(after?.owner).toBe("verify-cased")
  })

  test("xhawk-1: merging repos that share a commit sha and a PR number does not abort the migration", async () => {
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

    const rows = await db.select().from(repos).where(eq(repos.repoName, "doodad"))
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

  test("xhawk-2: a repo a user-owned project references is not re-owned to an org", async () => {
    const org = await seedOrg("xhawk2-org")
    const alice = await seedUser()
    await seedMembership(alice.id, org.id)

    // Alice belongs to the org whose name matches the repo, but she captured it into her own
    // project. Flipping the repo to the org would leave that project's next capture creating a
    // second, user-owned row -- the split this whole change exists to close.
    const repo = await seedRepo("xhawk2-org", "personal-take", { ownerUserId: alice.id })
    const project = await seedProject("personal-take", { ownerUserId: alice.id })
    const session = await seedSession(project.id, alice.id)
    await seedMessage(session, repo.id)

    await run()

    const [after] = await db.select().from(repos).where(eq(repos.id, repo.id))
    expect(after).toMatchObject({ ownerUserId: alice.id, ownerOrgId: null })
  })

  test("xhawk-3: a project whose named repos stay ambiguous does not keep the step working forever", async () => {
    const alice = await seedUser()
    const project = await seedProject("ambiguous", { ownerUserId: alice.id })
    // Two candidates, neither on github.com, so the preference cannot narrow them to one -- and no
    // messages, so the dominant-repo fallback has nothing to decide with either.
    await seedRepo("amb-org", "ambiguous", { ownerUserId: alice.id }, "gitlab.com")
    await seedRepo("amb-org", "ambiguous", { ownerUserId: alice.id }, "bitbucket.org")

    await run()

    const [after] = await db.select().from(projects).where(eq(projects.id, project.id))
    expect(after?.repoId).toBeNull()
    expect(await hasWork(client)).toBe(false)
  })

  test("R3: a local repo keyed by an absolute path keeps its casing", async () => {
    const alice = await seedUser()
    const local = await seedRepo(
      "/Users/Maya/Projects/Thing",
      "Thing",
      { ownerUserId: alice.id },
      "local",
    )

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
    const project = await seedProject("kit", { ownerOrgId: org.id })

    // Two same-named candidates, neither on github.com: the preference cannot narrow them to one.
    await seedRepo("sc19-org", "kit", { ownerOrgId: org.id }, "gitlab.com")
    const onBitbucket = await seedRepo("sc19-org", "kit", { ownerOrgId: org.id }, "bitbucket.org")

    const session = await seedSession(project.id, alice.id)
    await seedMessage(session, onBitbucket.id)

    await run()

    const [projectAfter] = await db.select().from(projects).where(eq(projects.id, project.id))
    expect(projectAfter?.repoId).toBe(onBitbucket.id)
  })
})
