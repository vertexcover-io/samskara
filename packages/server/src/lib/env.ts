import {
  CREDENTIAL_ENV,
  DEFAULT_REVIEW_MODEL,
  hasCredential,
  REVIEW_HARNESSES,
  type ReviewHarness,
} from "@samskara/core"
import { z } from "zod"

// The harness enum, the model pattern and the per-harness default model live in core beside
// the runner that consumes them, so the CLI can drive a harness without the server package.
// Re-exported here because every server caller reads its review config from env.
export {
  CREDENTIAL_ENV,
  DEFAULT_REVIEW_MODEL,
  hasCredential,
  REVIEW_HARNESSES,
  REVIEW_MODEL_PATTERN,
  type ReviewHarness,
} from "@samskara/core"

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
  /**
   * Which CLI runs the reviewer agent. Each harness carries its own default model; an
   * explicit AI_REVIEW_MODEL overrides either default.
   */
  AI_REVIEW_HARNESS: z.enum(REVIEW_HARNESSES).default("opencode"),
  AI_REVIEW_MODEL: z.string().min(1).optional(),
  AI_REVIEW_TIMEOUT_MS: z
    .string()
    .regex(/^\d+$/, "AI_REVIEW_TIMEOUT_MS must be digits (milliseconds)")
    .default("600000")
    .transform((value) => Number(value)),
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

/**
 * The reviewer's credential is configuration, not something the pipeline discovers at run
 * time, so a server whose own harness cannot authenticate refuses to start rather than
 * accepting analyze requests that are all going to fail minutes in.
 *
 * Only the *configured* harness is required. A request may override the harness per run, and
 * that case is caught by the pipeline with a named error — making both credentials mandatory
 * would force a single-harness deployment to hold a second provider's secret.
 */
const requireHarnessCredential =
  (source: Source) =>
  (data: z.infer<typeof BaseEnvSchema>, ctx: z.RefinementCtx): void => {
    const harness = data.AI_REVIEW_HARNESS
    if (hasCredential(harness, source)) return
    ctx.addIssue({
      code: "custom",
      path: [CREDENTIAL_ENV[harness][0] as string],
      message: `${CREDENTIAL_ENV[harness].join(" or ")} is required for AI_REVIEW_HARNESS=${harness}`,
    })
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
  readonly localLoginSecret?: string | undefined
  readonly localLoginLogin?: string | undefined
  readonly aiReviewHarness: ReviewHarness
  readonly aiReviewModel: string
  readonly aiReviewTimeoutMs: number
}

type Source = Record<string, string | undefined>

export const loadEnv = (source: Source = process.env): Env => {
  const parsed = BaseEnvSchema.superRefine(requireSignInMethod)
    .superRefine(requireHarnessCredential(source))
    .safeParse(source)
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
