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
   * Off renders captured markup with no sandbox and no CSP, so a report loads its own media over an
   * authenticated session. It also lets any script inside that report act as the signed-in user --
   * read every session and artifact they can see, and post it anywhere. Sound only where every
   * agent whose output lands here is trusted, which is why the default stays on.
   */
  ARTIFACT_PREVIEW_SANDBOX: z.enum(["on", "off"]).default("on"),
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
