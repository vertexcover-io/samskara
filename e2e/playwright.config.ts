import { defineConfig } from "@playwright/test"

const JWT_SECRET = process.env.JWT_SECRET ?? "e2e-secret"

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://samskara:samskara@localhost:5433/samskara"

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.ts",
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: "http://localhost:8000", trace: "retain-on-failure" },
  webServer: [
    {
      command: "bun x tsx src/index.ts",
      url: "http://localhost:3000/health",
      cwd: "../packages/server",
      reuseExistingServer: !process.env.CI,
      gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
      timeout: 60_000,
      env: {
        JWT_SECRET,
        DATABASE_URL,
        GITHUB_CLIENT_ID: process.env.GITHUB_CLIENT_ID ?? "e2e-client-id",
        GITHUB_CLIENT_SECRET: process.env.GITHUB_CLIENT_SECRET ?? "e2e-client-secret",
        PUBLIC_BASE_URL: "http://localhost:3000",
        WEB_BASE_URL: "http://localhost:8000",
        COOKIE_SECURE: "false",
      },
    },
    {
      command: "bun x vite",
      url: "http://localhost:8000",
      cwd: "../packages/web",
      reuseExistingServer: !process.env.CI,
      gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
      timeout: 60_000,
    },
  ],
})
