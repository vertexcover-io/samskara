// AI-generated. See PROMPT.md for the prompts and model used.

import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().url().or(z.string().startsWith("postgres")),
  JWT_SECRET: z.string().min(8),
  EMBED_PROVIDER: z.enum(["openai", "bge", "fake", "none"]).default("openai"),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_EMBED_MODEL: z.string().default("text-embedding-3-small"),
  PORT: z.coerce.number().int().positive().default(3000),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  COOKIE_SECURE: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === "true")),
  // GitHub OAuth (org-gated login). Client id/secret are optional so tests
  // and non-OAuth local runs still boot; the OAuth route throws a clear error
  // at request time when they're missing (mirrors the OPENAI_API_KEY pattern).
  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),
  GITHUB_ORG: z.string().default("vertexcover-io"),
  // Logins that bypass the org-membership gate (comma-separated).
  GITHUB_ALLOWED_LOGINS: z.string().default("aksdev87,amankumarsingh77,kgritesh"),
  // Used to build the OAuth redirect_uri; falls back to the request origin.
  APP_BASE_URL: z.string().url().optional(),
});

export type Env = z.infer<typeof envSchema>;

export const loadEnv = (source: NodeJS.ProcessEnv = process.env): Env => {
  return envSchema.parse(source);
};
