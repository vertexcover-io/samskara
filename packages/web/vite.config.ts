import { fileURLToPath } from "node:url"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig, loadEnv } from "vite"

const envDir = fileURLToPath(new URL("../..", import.meta.url))

export default defineConfig(({ mode }) => {
  // `vite` is launched without --env-file, so nothing has put the repo-root .env into process.env.
  // Read it here: in a worktree that file is the only record of the branch's own port pair, and
  // without it every branch's web server lands on 8000 and proxies /api at the main checkout.
  const fileEnv = loadEnv(mode, envDir, "")
  const read = (key: string) => process.env[key] ?? fileEnv[key]

  // Ports are overridable so the e2e stack can run on its own pair without colliding
  // with a `bun dev` server already holding the defaults.
  const port = Number(read("WEB_PORT") ?? 8000)
  const apiTarget = read("API_PROXY_TARGET") ?? `http://localhost:${read("PORT") ?? 3000}`

  return {
    envDir,
    plugins: [react(), tailwindcss()],
    server: {
      port,
      proxy: {
        "/api": { target: apiTarget, changeOrigin: true },
      },
    },
  }
})
