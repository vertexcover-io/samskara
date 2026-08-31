import { z } from "zod"

const EnvSchema = z.object({
  GITHUB_CLIENT_ID: z.string().min(1),
  GITHUB_CLIENT_SECRET: z.string().min(1),
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
  LOCAL_LOGIN_LOGIN: z.string().min(1).default("samskara-dev"),
  /**
   * Which CLI runs the reviewer agent. Each harness carries its own default model; an
   * explicit AI_REVIEW_MODEL overrides either default.
   */
  AI_REVIEW_HARNESS: z.enum(["opencode", "claude"]).default("opencode"),
  AI_REVIEW_MODEL: z.string().min(1).optional(),
  AI_REVIEW_TIMEOUT_MS: z
    .string()
    .regex(/^\d+$/, "AI_REVIEW_TIMEOUT_MS must be digits (milliseconds)")
    .default("600000")
    .transform((value) => Number(value)),
})

/** A model id the paired harness CLI understands when no explicit one is configured. */
export const DEFAULT_REVIEW_MODEL: Readonly<Record<"opencode" | "claude", string>> = {
  opencode: "zai-coding-plan/glm-5.3-flash",
  claude: "sonnet",
}

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
  readonly localLoginSecret: string
  readonly localLoginLogin: string
  readonly aiReviewHarness: "opencode" | "claude"
  readonly aiReviewModel: string
  readonly aiReviewTimeoutMs: number
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
    aiReviewHarness: parsed.data.AI_REVIEW_HARNESS,
    aiReviewModel:
      parsed.data.AI_REVIEW_MODEL ?? DEFAULT_REVIEW_MODEL[parsed.data.AI_REVIEW_HARNESS],
    aiReviewTimeoutMs: parsed.data.AI_REVIEW_TIMEOUT_MS,
  }
}
