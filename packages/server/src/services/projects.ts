import type { CreateProjectRequest } from "@samskara/core"
import type { Querier } from "../db/client.js"
import * as orgsRepo from "../repositories/orgs.repo.js"
import * as projectsRepo from "../repositories/projects.repo.js"
import * as userOrgsRepo from "../repositories/userOrgs.repo.js"

export type FindOrCreateResult = {
  readonly id: string
  readonly created: boolean
  readonly owner: { readonly type: "user" } | { readonly type: "org"; readonly slug: string }
  readonly reason?: "notMember"
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

  if (org !== null && remote !== undefined && (await userOrgsRepo.isMember(db, userId, org.id))) {
    // Derived from the verified remote, not the client-supplied slug: two clones of the same
    // repo can disagree on remote casing, and a client-trusted slug would give each one its own
    // project row instead of sharing the one org row R11 requires.
    const row = await projectsRepo.upsertOwned(db, {
      identity: {
        name: remote.repoName,
        slug: `${org.githubSlug}-${remote.repoName.toLowerCase()}`,
      },
      owner: { kind: "org", orgId: org.id },
    })
    return { ...row, owner: { type: "org", slug: org.githubSlug } }
  }

  const row = await projectsRepo.upsertOwned(db, { identity, owner: { kind: "user", userId } })
  // Reaching here with a registered org means the caller is not one of its members.
  return {
    ...row,
    owner: { type: "user" },
    ...(org === null ? {} : { reason: "notMember" as const }),
  }
}
