import type { CreateProjectRequest, ProjectRemote, ReassignSessionsRequest } from "@samskara/core"
import type { Querier } from "../db/client.js"
import * as orgsRepo from "../repositories/orgs.repo.js"
import * as projectsRepo from "../repositories/projects.repo.js"
import * as reposRepo from "../repositories/repos.repo.js"
import * as sessionsRepo from "../repositories/sessions.repo.js"
import * as userOrgsRepo from "../repositories/userOrgs.repo.js"
import * as usersRepo from "../repositories/users.repo.js"

export type FindOrCreateResult = {
  readonly id: string
  readonly created: boolean
  readonly owner: { readonly type: "user" } | { readonly type: "org"; readonly slug: string }
  /** The owner this call resolved, so a caller in the same transaction need not re-read it. */
  readonly ownerRef: reposRepo.RepoOwnerRef
  readonly reason?: "notMember"
}

const mayOwnForOrg = async (db: Querier, userId: string, orgId: string): Promise<boolean> =>
  (await userOrgsRepo.isMember(db, userId, orgId)) || usersRepo.isSuperAdmin(db, userId)

/** The repo takes the project's own owner, so the two can never disagree about who owns it. */
const linkRepo = async (
  db: Querier,
  projectId: string,
  remote: ProjectRemote,
  owner: reposRepo.RepoOwnerRef,
): Promise<void> => {
  const repoId = await reposRepo.upsertByIdentity(db, remote, owner)
  await projectsRepo.setRepoId(db, projectId, repoId)
}

export const findOrCreateProject = async (
  db: Querier,
  userId: string,
  identity: CreateProjectRequest,
): Promise<FindOrCreateResult> => {
  const { remote } = identity
  const org =
    remote !== undefined && remote.host === "github.com"
      ? await orgsRepo.findBySlug(db, remote.owner.toLowerCase())
      : null

  if (org !== null && remote !== undefined && (await mayOwnForOrg(db, userId, org.id))) {
    const owner: reposRepo.RepoOwnerRef = { kind: "org", orgId: org.id }
    // Derived from the verified remote, not the client-supplied slug: two clones of the same
    // repo can disagree on remote casing, and a client-trusted slug would give each one its own
    // project row instead of sharing the one org row R11 requires.
    const row = await projectsRepo.upsertOwned(db, {
      identity: {
        name: remote.repoName,
        slug: `${org.githubSlug}-${remote.repoName.toLowerCase()}`,
      },
      owner,
    })
    await linkRepo(db, row.id, remote, owner)
    return { ...row, owner: { type: "org", slug: org.githubSlug }, ownerRef: owner }
  }

  const owner: reposRepo.RepoOwnerRef = { kind: "user", userId }
  const row = await projectsRepo.upsertOwned(db, { identity, owner })
  if (remote !== undefined) await linkRepo(db, row.id, remote, owner)
  // Reaching here with a registered org means the caller is not one of its members.
  return {
    ...row,
    owner: { type: "user" },
    ownerRef: owner,
    ...(org === null ? {} : { reason: "notMember" as const }),
  }
}

export type ReassignResult =
  | { readonly moved: number }
  | { readonly error: "destinationForbidden" | "superAdminRequired" }

/**
 * Only the destination is gated. `scope: "mine"` moves rows the caller already owns, so a read
 * check on the source would block the one case that must work -- pulling your own sessions out of
 * a project you have lost access to, which is a folder pinned to a deleted project's only way
 * back. `scope: "all"` rewrites other people's rows, and since visibility is derived from
 * `sessions.projectId`, that hands every reader of the destination the source's history; admin on
 * the source does not bound who those readers are, so only a super admin may do it.
 */
export const reassignSessions = async (
  db: Querier,
  userId: string,
  toProjectId: string,
  { fromProjectId, scope }: ReassignSessionsRequest,
): Promise<ReassignResult> => {
  if (!(await projectsRepo.canWrite(db, userId, toProjectId)))
    return { error: "destinationForbidden" }

  if (scope === "all" && !(await usersRepo.isSuperAdmin(db, userId)))
    return { error: "superAdminRequired" }

  if (fromProjectId === toProjectId) return { moved: 0 }

  return {
    moved: await sessionsRepo.reassignProject(db, { userId, fromProjectId, toProjectId, scope }),
  }
}
