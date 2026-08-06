import { z } from "zod"

const EnvSchema = z.object({
  GITHUB_CLIENT_ID: z.string().min(1),
  GITHUB_CLIENT_SECRET: z.string().min(1),
  PUBLIC_BASE_URL: z.string().min(1),
  WEB_BASE_URL: z.string().url().default("http://localhost:8000"),
  COOKIE_SECURE: z.enum(["true", "false"]).transform((value) => value === "true"),
  JWT_SECRET: z.string().min(1),
  JWT_EXPIRES_IN: z.string().min(1).default("7d"),
  // Optional. Absent, the server falls back to `unconfiguredEmbeddingClient` and search degrades
  // to keyword-only -- an unconfigured deployment behaves like a provider outage.
  // The shipped local default is Ollama (see .env.example); any OpenAI-shaped provider works by
  // changing these values alone.
  EMBEDDING_BASE_URL: z.string().min(1).optional(),
  EMBEDDING_API_KEY: z.string().min(1).optional(),
  EMBEDDING_MODEL: z.string().min(1).optional(),
  // Query-side instruction prefix for open models that express the document/query asymmetry as
  // literal text rather than Voyage's `input_type`.
  EMBEDDING_QUERY_PREFIX: z.string().optional(),
})

export type Env = {
  readonly githubClientId: string
  readonly githubClientSecret: string
  readonly publicBaseUrl: string
  readonly webBaseUrl: string
  readonly cookieSecure: boolean
  readonly jwtSecret: string
  readonly jwtExpiresIn: string
  readonly embeddingBaseUrl?: string
  readonly embeddingApiKey?: string
  readonly embeddingModel?: string
  readonly embeddingQueryPrefix?: string
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
    embeddingBaseUrl: parsed.data.EMBEDDING_BASE_URL,
    embeddingApiKey: parsed.data.EMBEDDING_API_KEY,
    embeddingModel: parsed.data.EMBEDDING_MODEL,
    embeddingQueryPrefix: parsed.data.EMBEDDING_QUERY_PREFIX,
  }
}
