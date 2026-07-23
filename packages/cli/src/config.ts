import { z } from "zod"

const ConfigSchema = z.object({
  SAMSKARA_API_URL: z.string().min(1).default("http://localhost:3000"),
})

const parsed = ConfigSchema.parse(process.env)

export const apiBase = parsed.SAMSKARA_API_URL
