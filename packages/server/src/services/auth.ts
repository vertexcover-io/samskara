import type { Db } from "../db/client.js"
import * as orgsRepo from "../repositories/orgs.repo.js"
import * as userOrgsRepo from "../repositories/userOrgs.repo.js"
import * as usersRepo from "../repositories/users.repo.js"
import type { GithubProfile } from "./github.js"

export class NotMemberError extends Error {
  constructor() {
    super("user is not a member of any seeded org")
    this.name = "NotMemberError"
  }
}

export type User = usersRepo.User
export type { RegisteredOrg } from "../repositories/orgs.repo.js"

export const planMembership = (
  registered: ReadonlyArray<orgsRepo.RegisteredOrg>,
): userOrgsRepo.MembershipPlan => ({
  add: registered.filter((org) => org.autoAddMembers).map((org) => org.id),
  keep: registered.map((org) => org.id),
})

/** GitHub logins are case-insensitive, so the comparison is too. */
export const isSuperAdminLogin = (configured: ReadonlyArray<string>, login: string): boolean =>
  configured.includes(login.toLowerCase())

/**
 * `bypass` lets a project author in before any org exists -- the gate is about strangers, and an
 * author locked out of their own deployment cannot seed the org that would let them in.
 */
export const gateOrgs = async (
  db: Db,
  userOrgSlugs: ReadonlyArray<string>,
  { bypass = false }: { readonly bypass?: boolean } = {},
): Promise<{ registered: ReadonlyArray<orgsRepo.RegisteredOrg> }> => {
  const registered = await orgsRepo.findBySlugs(db, userOrgSlugs)
  if (bypass) return { registered }
  if (registered.length === 0) throw new NotMemberError()
  return { registered }
}

export const getUserById = (db: Db, id: string): Promise<User | null> => usersRepo.findById(db, id)

export const upsertUserFromGithub = (
  db: Db,
  profile: GithubProfile,
  isSuperAdmin: boolean,
): Promise<User> =>
  usersRepo.upsertByGithubId(db, {
    githubId: profile.githubId,
    githubLogin: profile.login,
    email: profile.email ?? null,
    name: profile.login,
    avatarUrl: profile.avatarUrl ?? null,
    isSuperAdmin,
  })

export const syncUserOrgs = (
  db: Db,
  userId: string,
  registered: ReadonlyArray<orgsRepo.RegisteredOrg>,
): Promise<void> => userOrgsRepo.sync(db, userId, planMembership(registered))

/**
 * The rejection path must revoke, not just refuse. A demoted author is bounced by the org gate
 * before the login upsert runs, so if this left `isSuperAdmin` set they would keep global access
 * on their live cookie -- refused at the door while still holding the keys.
 */
export const revokeAccess = async (db: Db, githubId: number): Promise<void> => {
  const user = await usersRepo.findByGithubId(db, githubId)
  if (!user) return
  await Promise.all([syncUserOrgs(db, user.id, []), usersRepo.demote(db, user.id)])
}
