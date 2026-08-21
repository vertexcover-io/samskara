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
): { readonly add: ReadonlyArray<string>; readonly keep: ReadonlyArray<string> } => ({
  add: registered.filter((org) => org.autoAddMembers).map((org) => org.id),
  keep: registered.map((org) => org.id),
})

export const gateOrgs = async (
  db: Db,
  userOrgSlugs: ReadonlyArray<string>,
): Promise<{ registered: ReadonlyArray<orgsRepo.RegisteredOrg> }> => {
  if (userOrgSlugs.length === 0) throw new NotMemberError()

  const registered = await orgsRepo.findBySlugs(db, userOrgSlugs)
  if (registered.length === 0) throw new NotMemberError()
  return { registered }
}

export const getUserById = (db: Db, id: string): Promise<User | null> => usersRepo.findById(db, id)

export const upsertUserFromGithub = (db: Db, profile: GithubProfile): Promise<User> =>
  usersRepo.upsertByGithubId(db, {
    githubId: profile.githubId,
    githubLogin: profile.login,
    email: profile.email ?? null,
    name: profile.login,
    avatarUrl: profile.avatarUrl ?? null,
  })

export const syncUserOrgs = (
  db: Db,
  userId: string,
  registered: ReadonlyArray<orgsRepo.RegisteredOrg>,
): Promise<void> => userOrgsRepo.sync(db, userId, planMembership(registered))

export const dropUserOrgs = async (db: Db, githubId: number): Promise<void> => {
  const user = await usersRepo.findByGithubId(db, githubId)
  if (user) await userOrgsRepo.sync(db, user.id, { add: [], keep: [] })
}
