import { z } from "zod"

const EnvSchema = z.object({
  GITHUB_CLIENT_ID: z.string().min(1),
  GITHUB_CLIENT_SECRET: z.string().min(1),
  PUBLIC_BASE_URL: z.string().min(1),
  WEB_BASE_URL: z.string().url().default("http://localhost:8000"),
  COOKIE_SECURE: z.enum(["true", "false"]).transform((value) => value === "true"),
  JWT_SECRET: z.string().min(1),
  JWT_EXPIRES_IN: z.string().min(1).default("7d"),
  /**
   * Defaults off, for an internal deployment where every agent whose output lands here is trusted.
   * A captured report then renders as an ordinary same-origin page, which is what lets it load its
   * own screenshots and recordings over an authenticated session.
   *
   * The cost is the whole protection, and it is not partial. A script inside such a report acts as
   * the signed-in user, can read every session and artifact they can see, and can post that
   * anywhere. Prompt injection reaches it -- text the agent merely read can steer what it later
   * writes -- so "we trust our agents" is a statement about every input those agents consume.
   *
   * Set to `on` before this is served to anyone whose artifacts you do not control.
   */
  ARTIFACT_PREVIEW_SANDBOX: z.enum(["on", "off"]).default("off"),
})

export type Env = {
  readonly githubClientId: string
  readonly githubClientSecret: string
  readonly publicBaseUrl: string
  readonly webBaseUrl: string
  readonly cookieSecure: boolean
  readonly jwtSecret: string
  readonly jwtExpiresIn: string
  readonly artifactPreviewSandbox: boolean
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
    webBaseUrl: parsed.data.WEB_BASE_URL,
    cookieSecure: parsed.data.COOKIE_SECURE,
    jwtSecret: parsed.data.JWT_SECRET,
    jwtExpiresIn: parsed.data.JWT_EXPIRES_IN,
    artifactPreviewSandbox: parsed.data.ARTIFACT_PREVIEW_SANDBOX === "on",
  }
}
