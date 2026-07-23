import { eq } from "drizzle-orm"
import type { Db } from "../db/client.js"
import { users } from "../db/schema.js"

export type User = typeof users.$inferSelect

export type UpsertUserInput = {
  readonly githubId: number
  readonly githubLogin: string
  readonly email: string | null
  readonly name: string
  readonly avatarUrl: string | null
}

export const findById = async (db: Db, id: string): Promise<User | null> => {
  const [user] = await db.select().from(users).where(eq(users.id, id))
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
    })
    .onConflictDoUpdate({
      target: users.githubId,
      set: {
        githubLogin: input.githubLogin,
        email: input.email,
        name: input.name,
        avatarUrl: input.avatarUrl,
        updatedAt: new Date(),
      },
    })
    .returning()
  if (!user) throw new Error("user upsert returned no row")
  return user
}
