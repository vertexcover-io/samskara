import { z } from "zod"

export const publicUserSchema = z.object({
  id: z.string().min(1),
  githubLogin: z.string().min(1),
  email: z.string().nullable(),
  name: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  isSuperAdmin: z.boolean().default(false),
})

export type PublicUser = z.infer<typeof publicUserSchema>
