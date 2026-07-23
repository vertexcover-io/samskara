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

export const gateOrgs = async (
  db: Db,
  userOrgSlugs: ReadonlyArray<string>,
): Promise<{ orgIds: ReadonlyArray<string> }> => {
  if (userOrgSlugs.length === 0) throw new NotMemberError()

  const matched = await orgsRepo.findBySlugs(db, userOrgSlugs)
  if (matched.length === 0) throw new NotMemberError()
  return { orgIds: matched.map((org) => org.id) }
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
  orgIds: ReadonlyArray<string>,
): Promise<void> => userOrgsRepo.linkMany(db, userId, orgIds)
