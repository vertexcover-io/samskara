import { z } from "zod"

const EnvSchema = z.object({
  GITHUB_CLIENT_ID: z.string().min(1),
  GITHUB_CLIENT_SECRET: z.string().min(1),
  PUBLIC_BASE_URL: z.string().min(1),
  COOKIE_SECURE: z.enum(["true", "false"]).transform((value) => value === "true"),
  JWT_SECRET: z.string().min(1),
  JWT_EXPIRES_IN: z.string().min(1).default("7d"),
})

export type Env = {
  readonly githubClientId: string
  readonly githubClientSecret: string
  readonly publicBaseUrl: string
  readonly cookieSecure: boolean
  readonly jwtSecret: string
  readonly jwtExpiresIn: string
}

type Source = Record<string, string | undefined>

export const loadEnv = (source: Source = process.env): Env => {
  const parsed = EnvSchema.safeParse(source)
  if (!parsed.success) {
    const keys = parsed.error.issues.map((issue) => issue.path.join(".")).join(", ")
    throw new Error(`Invalid environment configuration: ${keys}`)
  }
  return {
    githubClientId: parsed.data.GITHUB_CLIENT_ID,
    githubClientSecret: parsed.data.GITHUB_CLIENT_SECRET,
    publicBaseUrl: parsed.data.PUBLIC_BASE_URL,
    cookieSecure: parsed.data.COOKIE_SECURE,
    jwtSecret: parsed.data.JWT_SECRET,
    jwtExpiresIn: parsed.data.JWT_EXPIRES_IN,
  }
}
