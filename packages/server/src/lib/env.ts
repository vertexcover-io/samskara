import { z } from "zod"

export const DEFAULT_LOCAL_LOGIN = "samskara-dev"

const BaseEnvSchema = z.object({
  GITHUB_CLIENT_ID: z.string().default(""),
  GITHUB_CLIENT_SECRET: z.string().default(""),
  PUBLIC_BASE_URL: z.string().min(1),
  WEB_BASE_URL: z.string().url().optional(),
  COOKIE_SECURE: z.enum(["true", "false"]).transform((value) => value === "true"),
  JWT_SECRET: z.string().min(1),
  JWT_EXPIRES_IN: z.string().min(1).default("7d"),
  WEB_DIST: z.string().min(1).optional(),
  SUPER_ADMIN_LOGINS: z
    .string()
    .default("")
    .transform((raw) =>
      raw
        .split(",")
        .map((login) => login.trim().toLowerCase())
        .filter((login) => login.length > 0),
    ),
  LOCAL_LOGIN_SECRET: z.string().default(""),
  LOCAL_LOGIN_LOGIN: z.string().min(1).default(DEFAULT_LOCAL_LOGIN),
})

const requireSignInMethod = (data: z.infer<typeof BaseEnvSchema>, ctx: z.RefinementCtx): void => {
  if (data.LOCAL_LOGIN_SECRET.length > 0) return
  for (const key of ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"] as const) {
    if (data[key].length > 0) continue
    ctx.addIssue({
      code: "custom",
      path: [key],
      message: `${key} is required unless LOCAL_LOGIN_SECRET is set`,
    })
  }
}

const EnvSchema = BaseEnvSchema.superRefine(requireSignInMethod)

export type Env = {
  readonly githubClientId: string
  readonly githubClientSecret: string
  readonly publicBaseUrl: string
  readonly webBaseUrl: string
  readonly cookieSecure: boolean
  readonly jwtSecret: string
  readonly jwtExpiresIn: string
  readonly superAdminLogins: ReadonlyArray<string>
  readonly webDist?: string | undefined
  readonly localLoginSecret?: string | undefined
  readonly localLoginLogin?: string | undefined
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
    // The server serves the built web app, so the UI shares the API's origin unless a
    // deployment splits them. Defaulting to localhost instead sent production's post-login
    // redirects to the user's own machine.
    webBaseUrl: parsed.data.WEB_BASE_URL ?? parsed.data.PUBLIC_BASE_URL,
    cookieSecure: parsed.data.COOKIE_SECURE,
    jwtSecret: parsed.data.JWT_SECRET,
    jwtExpiresIn: parsed.data.JWT_EXPIRES_IN,
    superAdminLogins: parsed.data.SUPER_ADMIN_LOGINS,
    webDist: parsed.data.WEB_DIST,
    localLoginSecret: parsed.data.LOCAL_LOGIN_SECRET,
    localLoginLogin: parsed.data.LOCAL_LOGIN_LOGIN,
  }
}
