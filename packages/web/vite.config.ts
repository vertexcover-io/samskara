import { fileURLToPath } from "node:url"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// Ports are overridable so the e2e stack can run on its own pair without colliding
// with a `bun dev` server already holding the defaults.
const port = Number(process.env.WEB_PORT ?? 8000)
const apiTarget = process.env.API_PROXY_TARGET ?? "http://localhost:3000"

export default defineConfig({
  envDir: fileURLToPath(new URL("../..", import.meta.url)),
  plugins: [react(), tailwindcss()],
  server: {
    port,
    proxy: {
      "/api": { target: apiTarget, changeOrigin: true },
    },
  },
})
