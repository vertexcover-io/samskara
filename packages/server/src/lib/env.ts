import { z } from "zod"
import type { DbRuntimeConfig } from "../db/client.js"

const positiveInteger = (name: string, fallback: number, maximum: number) =>
  z
    .string()
    .default(String(fallback))
    .transform((value, context) => {
      if (!/^\d+$/.test(value)) {
        context.addIssue({ code: "custom", message: `${name} must be an integer` })
        return z.NEVER
      }
      return Number(value)
    })
    .refine((value) => value > 0 && value <= maximum, `${name} must be between 1 and ${maximum}`)

const EnvSchema = z.object({
  GITHUB_CLIENT_ID: z.string().min(1),
  GITHUB_CLIENT_SECRET: z.string().min(1),
  PUBLIC_BASE_URL: z.string().min(1),
  WEB_BASE_URL: z.string().url().default("http://localhost:8000"),
  COOKIE_SECURE: z.enum(["true", "false"]).transform((value) => value === "true"),
  JWT_SECRET: z.string().min(1),
  JWT_EXPIRES_IN: z.string().min(1).default("7d"),
  DB_POOL_MAX: positiveInteger("DB_POOL_MAX", 10, 100),
  DB_CONNECT_TIMEOUT_SECONDS: positiveInteger("DB_CONNECT_TIMEOUT_SECONDS", 10, 120),
  DB_IDLE_TIMEOUT_SECONDS: positiveInteger("DB_IDLE_TIMEOUT_SECONDS", 30, 3_600),
  DB_STATEMENT_TIMEOUT_SECONDS: positiveInteger("DB_STATEMENT_TIMEOUT_SECONDS", 30, 3_600),
  SERVER_TIMING: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
})

export type Env = {
  readonly githubClientId: string
  readonly githubClientSecret: string
  readonly publicBaseUrl: string
  readonly webBaseUrl: string
  readonly cookieSecure: boolean
  readonly jwtSecret: string
  readonly jwtExpiresIn: string
  readonly db?: DbRuntimeConfig
  readonly serverTiming?: boolean
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
    db: {
      poolMax: parsed.data.DB_POOL_MAX,
      connectTimeoutSeconds: parsed.data.DB_CONNECT_TIMEOUT_SECONDS,
      idleTimeoutSeconds: parsed.data.DB_IDLE_TIMEOUT_SECONDS,
      statementTimeoutSeconds: parsed.data.DB_STATEMENT_TIMEOUT_SECONDS,
    },
    serverTiming: parsed.data.SERVER_TIMING,
  }
}
