import type { CreateProjectRequest, ProjectRemote } from "@samskara/core"
import type { Querier } from "../db/client.js"
import * as orgsRepo from "../repositories/orgs.repo.js"
import * as projectsRepo from "../repositories/projects.repo.js"
import * as userOrgsRepo from "../repositories/userOrgs.repo.js"

type RegisteredOrg = NonNullable<Awaited<ReturnType<typeof orgsRepo.findBySlug>>>

export type OwnerChoice =
  | { readonly kind: "user"; readonly reason?: "notMember" }
  | { readonly kind: "org" }

export const ownerFor = (input: {
  readonly remote: ProjectRemote | undefined
  readonly org: RegisteredOrg | null
  readonly isMember: boolean
}): OwnerChoice => {
  if (input.remote === undefined || input.remote.host !== "github.com" || input.org === null) {
    return { kind: "user" }
  }
  return input.isMember ? { kind: "org" } : { kind: "user", reason: "notMember" }
}

const registeredOrgFor = (
  db: Querier,
  remote: ProjectRemote | undefined,
): Promise<RegisteredOrg | null> =>
  remote !== undefined && remote.host === "github.com"
    ? orgsRepo.findBySlug(db, remote.owner.toLowerCase())
    : Promise.resolve(null)

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
  const org = await registeredOrgFor(db, identity.remote)
  const isMember = org !== null && (await userOrgsRepo.isMember(db, userId, org.id))
  const choice = ownerFor({ remote: identity.remote, org, isMember })
  if (choice.kind === "org" && org !== null) {
    const row = await projectsRepo.upsertOwned(db, {
      identity,
      owner: { kind: "org", orgId: org.id },
    })
    return { ...row, owner: { type: "org", slug: org.githubSlug } }
  }
  const row = await projectsRepo.upsertOwned(db, { identity, owner: { kind: "user", userId } })
  return {
    ...row,
    owner: { type: "user" },
    ...(choice.kind === "user" && choice.reason ? { reason: choice.reason } : {}),
  }
}

export const writableProjectId = async (
  db: Querier,
  userId: string,
  projectId: string,
): Promise<string | null> =>
  (await projectsRepo.canWrite(db, userId, projectId)) ? projectId : null
