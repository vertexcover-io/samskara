import {
  CREDENTIAL_ENV,
  DEFAULT_REVIEW_MODEL,
  type HarnessSource,
  hasCredential,
  REVIEW_HARNESSES,
  REVIEW_MODEL_PATTERN,
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
  /**
   * The agent harness the sessions ran (yok, for us), whose code the learning run checks each
   * learning against: a GitHub repo as `owner/name`, cloned fresh for every run, or a local
   * checkout. One or the other; with neither, the run never starts on its own.
   */
  LEARNINGS_HARNESS_REPO: z
    .string()
    .regex(
      /^[\w.-]+\/[\w.-]+$/,
      "LEARNINGS_HARNESS_REPO must be owner/name, e.g. vertexcover-io/yok",
    )
    .optional(),
  /** Only for a private LEARNINGS_HARNESS_REPO: a token that can read it. */
  LEARNINGS_HARNESS_GITHUB_TOKEN: z.string().min(1).optional(),
  LEARNINGS_HARNESS_PATH: z.string().min(1).optional(),
  /**
   * The model both learning agents use. Unset: opus on the claude harness; on opencode, which
   * has no model by that name, the reviewer's own model.
   */
  LEARNINGS_MODEL: z.string().min(1).regex(REVIEW_MODEL_PATTERN).optional(),
})

/** A repo and a local checkout both set would leave which one the run reads to chance. */
const oneLearningsHarness = (data: z.infer<typeof BaseEnvSchema>, ctx: z.RefinementCtx): void => {
  if (data.LEARNINGS_HARNESS_REPO !== undefined && data.LEARNINGS_HARNESS_PATH !== undefined)
    ctx.addIssue({
      code: "custom",
      path: ["LEARNINGS_HARNESS_REPO"],
      message: "set LEARNINGS_HARNESS_REPO or LEARNINGS_HARNESS_PATH, not both",
    })
}

const learningsHarnessOf = (data: z.infer<typeof BaseEnvSchema>): HarnessSource | undefined => {
  if (data.LEARNINGS_HARNESS_REPO !== undefined)
    return data.LEARNINGS_HARNESS_GITHUB_TOKEN === undefined
      ? { github: data.LEARNINGS_HARNESS_REPO }
      : { github: data.LEARNINGS_HARNESS_REPO, token: data.LEARNINGS_HARNESS_GITHUB_TOKEN }
  if (data.LEARNINGS_HARNESS_PATH !== undefined) return { path: data.LEARNINGS_HARNESS_PATH }
  return undefined
}

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
  readonly learningsHarness?: HarnessSource | undefined
  /** Set by `loadEnv`; an Env built by hand (in tests) may leave it out for the review model. */
  readonly learningsModel?: string | undefined
}

type Source = Record<string, string | undefined>

export const loadEnv = (source: Source = process.env): Env => {
  const parsed = BaseEnvSchema.superRefine(requireSignInMethod)
    .superRefine(requireHarnessCredential(source))
    .superRefine(oneLearningsHarness)
    .safeParse(source)
  if (!parsed.success) {
    const keys = parsed.error.issues.map((issue) => issue.path.join(".")).join(", ")
    throw new Error(`Invalid environment configuration: ${keys}`)
  }
  const aiReviewModel =
    parsed.data.AI_REVIEW_MODEL ?? DEFAULT_REVIEW_MODEL[parsed.data.AI_REVIEW_HARNESS]
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
    aiReviewModel,
    aiReviewTimeoutMs: parsed.data.AI_REVIEW_TIMEOUT_MS,
    learningsHarness: learningsHarnessOf(parsed.data),
    learningsModel:
      parsed.data.LEARNINGS_MODEL ??
      (parsed.data.AI_REVIEW_HARNESS === "claude" ? "opus" : aiReviewModel),
  }
}
