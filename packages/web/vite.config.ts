import { fileURLToPath } from "node:url"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

export default defineConfig({
  envDir: fileURLToPath(new URL("../..", import.meta.url)),
  plugins: [react(), tailwindcss()],
  server: {
    port: 8000,
    proxy: {
      "/api": { target: "http://localhost:3000", changeOrigin: true },
    },
  },
})
