import {
  CREDENTIAL_ENV,
  DEFAULT_READER_CONCURRENCY,
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
export const DEFAULT_AI_AGENT_SLOTS = 4
/** Tries a review or fix run gets before it is `failed` and not picked again. */
export const DEFAULT_MAX_ATTEMPTS = 3
/** A session must go this many hours without a message before a nightly pick takes it. */
export const DEFAULT_QUIET_HOURS = 6
/**
 * Only sessions active within this many days are candidates, so the ranking reads two weeks of
 * a project's sessions rather than its whole history. Older ones are reviewed by ticking them.
 */
export const DEFAULT_PICK_WITHIN_DAYS = 14
/**
 * A reviewed session is picked again only once the person typed this many messages after its
 * newest run: one or two ("ok", "push") are not worth a review. Review by hand has no minimum.
 */
export const DEFAULT_MIN_NEW_USER_MESSAGES = 3

/** When the worker makes each night's pick, and how many sessions it takes per project. */
export type NightlyReview = {
  /** Wall-clock time of day as HH:MM, read in `timeZone`. */
  readonly at: string
  /** An IANA zone name, e.g. Asia/Kolkata. */
  readonly timeZone: string
  readonly limit: number
  /** Unset (an Env built by hand, in tests): `DEFAULT_QUIET_HOURS`; likewise the two below. */
  readonly quietHours?: number
  readonly pickWithinDays?: number
  readonly minNewUserMessages?: number
}

/** A whole number from `min` to `max`, read from text, with `fallback` when unset. */
const wholeNumber = (key: string, fallback: number, min: number, max?: number) =>
  z
    .string()
    .regex(/^\d+$/, `${key} must be a whole number`)
    .default(String(fallback))
    .transform((value) => Number(value))
    .refine(
      (value) => value >= min && (max === undefined || value <= max),
      max === undefined ? `${key} must be at least ${min}` : `${key} must be from ${min} to ${max}`,
    )

/**
 * An IANA name, which Postgres and Intl read alike; one Intl can't build Postgres rejects too.
 * A bare offset such as +05:30 is refused: Intl reads it as east of Greenwich, Postgres as a
 * POSIX zone with the sign reversed, so the pick would run about 11 hours off. `Etc/GMT+5` is
 * fine, since both read that name's reversed sign the same way.
 */
const isTimeZone = (value: string): boolean => {
  if (/^[+-]/.test(value)) return false
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value })
    return true
  } catch {
    return false
  }
}

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
  /** How many claude/opencode processes the worker runs at once; each opencode sandbox takes 2 GB. */
  AI_AGENT_SLOTS: z
    .string()
    .regex(/^[1-9]\d*$/, "AI_AGENT_SLOTS must be a whole number of at least 1")
    .default(String(DEFAULT_AI_AGENT_SLOTS))
    .transform((value) => Number(value)),
  /** How many readers one review runs at once; they share AI_AGENT_SLOTS with everything else. */
  AI_READER_CONCURRENCY: wholeNumber("AI_READER_CONCURRENCY", DEFAULT_READER_CONCURRENCY, 1),
  /** Tries a review or fix run gets before it is failed for good. */
  WORK_MAX_ATTEMPTS: wholeNumber("WORK_MAX_ATTEMPTS", DEFAULT_MAX_ATTEMPTS, 1, 10),
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
  /**
   * A read-only GitHub token: it clones a private LEARNINGS_HARNESS_REPO, and the worker's
   * nightly pick reads pull request states with it. Unset, the pick uses the quiet-hours rule alone.
   */
  LEARNINGS_HARNESS_GITHUB_TOKEN: z.string().min(1).optional(),
  LEARNINGS_HARNESS_PATH: z.string().min(1).optional(),
  /**
   * The model both learning agents use. Unset: opus on the claude harness; on opencode, which
   * has no model by that name, the reviewer's own model.
   */
  LEARNINGS_MODEL: z.string().min(1).regex(REVIEW_MODEL_PATTERN).optional(),
  /** The time of day the worker queues the night's automatic reviews, as HH:MM. */
  NIGHTLY_REVIEW_TIME: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "NIGHTLY_REVIEW_TIME must be HH:MM, e.g. 01:00")
    .default("01:00"),
  /** The zone NIGHTLY_REVIEW_TIME is read in, and whose calendar day a pick belongs to. */
  NIGHTLY_REVIEW_TIME_ZONE: z
    .string()
    .refine(
      isTimeZone,
      "NIGHTLY_REVIEW_TIME_ZONE must be an IANA zone name, e.g. Asia/Kolkata; an offset such as +05:30 is refused",
    )
    .default("Asia/Kolkata"),
  /** How many sessions each project gets reviewed per night; the rest wait for the next. */
  NIGHTLY_REVIEW_LIMIT: z
    .string()
    .regex(/^([1-9]|1\d|2[0-5])$/, "NIGHTLY_REVIEW_LIMIT must be a whole number from 1 to 25")
    .default("10")
    .transform((value) => Number(value)),
  /** Hours without a message before the nightly pick takes a session. */
  NIGHTLY_QUIET_HOURS: wholeNumber("NIGHTLY_QUIET_HOURS", DEFAULT_QUIET_HOURS, 1, 168),
  /** Only sessions active within this many days are candidates for the nightly pick. */
  NIGHTLY_PICK_WITHIN_DAYS: wholeNumber(
    "NIGHTLY_PICK_WITHIN_DAYS",
    DEFAULT_PICK_WITHIN_DAYS,
    1,
    365,
  ),
  /** New messages the person must type before a reviewed session is picked again. */
  NIGHTLY_MIN_NEW_USER_MESSAGES: wholeNumber(
    "NIGHTLY_MIN_NEW_USER_MESSAGES",
    DEFAULT_MIN_NEW_USER_MESSAGES,
    1,
    100,
  ),
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
  /** Set by `loadEnv`; an Env built by hand (in tests) may leave it out for the default. */
  readonly aiAgentSlots?: number
  /** Set by `loadEnv`; an Env built by hand (in tests) may leave it out for the default. */
  readonly maxAttempts?: number
  /** Set by `loadEnv`; an Env built by hand (in tests) may leave it out for the default. */
  readonly readerConcurrency?: number
  readonly learningsHarness?: HarnessSource | undefined
  /** LEARNINGS_HARNESS_GITHUB_TOKEN, read alone: the nightly pick asks GitHub for PR states. */
  readonly githubReadToken?: string | undefined
  /** Set by `loadEnv`; an Env built by hand (in tests) may leave it out for the review model. */
  readonly learningsModel?: string | undefined
  /** Set by `loadEnv`; an Env built by hand (in tests) may leave it out to queue no nightly reviews. */
  readonly nightlyReview?: NightlyReview
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
    aiAgentSlots: parsed.data.AI_AGENT_SLOTS,
    maxAttempts: parsed.data.WORK_MAX_ATTEMPTS,
    readerConcurrency: parsed.data.AI_READER_CONCURRENCY,
    learningsHarness: learningsHarnessOf(parsed.data),
    githubReadToken: parsed.data.LEARNINGS_HARNESS_GITHUB_TOKEN,
    learningsModel:
      parsed.data.LEARNINGS_MODEL ??
      (parsed.data.AI_REVIEW_HARNESS === "claude" ? "opus" : aiReviewModel),
    nightlyReview: {
      at: parsed.data.NIGHTLY_REVIEW_TIME,
      timeZone: parsed.data.NIGHTLY_REVIEW_TIME_ZONE,
      limit: parsed.data.NIGHTLY_REVIEW_LIMIT,
      quietHours: parsed.data.NIGHTLY_QUIET_HOURS,
      pickWithinDays: parsed.data.NIGHTLY_PICK_WITHIN_DAYS,
      minNewUserMessages: parsed.data.NIGHTLY_MIN_NEW_USER_MESSAGES,
    },
  }
}
