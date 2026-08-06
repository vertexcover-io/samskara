import { defineConfig } from "@playwright/test"

const JWT_SECRET = process.env.JWT_SECRET ?? "e2e-secret"

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://samskara:samskara@localhost:5433/samskara"

// The e2e stack runs on its own ports so it never adopts -- or fights with -- a `bun dev`
// server on the 3000/8000 defaults. A stale dev server signing with a different
// JWT_SECRET used to be reused silently, and every minted token then 401'd.
export const API_PORT = Number(process.env.E2E_API_PORT ?? 3100)
export const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 8100)
export const API_BASE = `http://localhost:${API_PORT}`
export const WEB_BASE = `http://localhost:${WEB_PORT}`

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.ts",
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: WEB_BASE, trace: "retain-on-failure" },
  webServer: [
    {
      command: "bun x tsx src/index.ts",
      url: `${API_BASE}/health`,
      cwd: "../packages/server",
      // Never adopt a foreign server: these ports belong to the e2e stack alone.
      reuseExistingServer: false,
      gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
      timeout: 60_000,
      env: {
        JWT_SECRET,
        DATABASE_URL,
        PORT: String(API_PORT),
        GITHUB_CLIENT_ID: process.env.GITHUB_CLIENT_ID ?? "e2e-client-id",
        GITHUB_CLIENT_SECRET: process.env.GITHUB_CLIENT_SECRET ?? "e2e-client-secret",
        PUBLIC_BASE_URL: API_BASE,
        WEB_BASE_URL: WEB_BASE,
        COOKIE_SECURE: "false",
        // Passed through only when already set, never defaulted. With them the e2e stack ranks
        // with the semantic half; without them it exercises D21's keyword-only degradation. Not
        // defaulted to Ollama on purpose: e2e assertions must not depend on a model being
        // installed, and a machine without one would otherwise look like a regression.
        ...(process.env.EMBEDDING_BASE_URL === undefined
          ? {}
          : {
              EMBEDDING_BASE_URL: process.env.EMBEDDING_BASE_URL,
              EMBEDDING_API_KEY: process.env.EMBEDDING_API_KEY ?? "ollama",
              EMBEDDING_MODEL: process.env.EMBEDDING_MODEL ?? "mxbai-embed-large",
              ...(process.env.EMBEDDING_QUERY_PREFIX === undefined
                ? {}
                : { EMBEDDING_QUERY_PREFIX: process.env.EMBEDDING_QUERY_PREFIX }),
            }),
      },
    },
    {
      command: "bun x vite",
      url: WEB_BASE,
      cwd: "../packages/web",
      reuseExistingServer: false,
      gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
      timeout: 60_000,
      env: {
        ...process.env,
        WEB_PORT: String(WEB_PORT),
        API_PROXY_TARGET: API_BASE,
      },
    },
  ],
})
