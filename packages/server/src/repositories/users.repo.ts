import { eq } from "drizzle-orm"
import type { Db, Querier } from "../db/client.js"
import { users } from "../db/schema.js"

export type User = typeof users.$inferSelect

export type UpsertUserInput = {
  readonly githubId: number
  readonly githubLogin: string
  readonly email: string | null
  readonly name: string
  readonly avatarUrl: string | null
  readonly isSuperAdmin: boolean
}

export const findById = async (db: Db, id: string): Promise<User | null> => {
  const [user] = await db.select().from(users).where(eq(users.id, id))
  return user ?? null
}

export const isSuperAdmin = async (db: Querier, id: string): Promise<boolean> => {
  const [row] = await db
    .select({ isSuperAdmin: users.isSuperAdmin })
    .from(users)
    .where(eq(users.id, id))
  return row?.isSuperAdmin === true
}

export const demote = async (db: Db, id: string): Promise<void> => {
  await db.update(users).set({ isSuperAdmin: false, updatedAt: new Date() }).where(eq(users.id, id))
}

export const findByGithubId = async (db: Db, githubId: number): Promise<User | null> => {
  const [user] = await db.select().from(users).where(eq(users.githubId, githubId))
  return user ?? null
}

export const upsertByGithubId = async (db: Db, input: UpsertUserInput): Promise<User> => {
  const [user] = await db
    .insert(users)
    .values({
      githubId: input.githubId,
      githubLogin: input.githubLogin,
      email: input.email,
      name: input.name,
      avatarUrl: input.avatarUrl,
      isSuperAdmin: input.isSuperAdmin,
    })
    .onConflictDoUpdate({
      target: users.githubId,
      set: {
        githubLogin: input.githubLogin,
        email: input.email,
        name: input.name,
        avatarUrl: input.avatarUrl,
        isSuperAdmin: input.isSuperAdmin,
        updatedAt: new Date(),
      },
    })
    .returning()
  if (!user) throw new Error("user upsert returned no row")
  return user
}
