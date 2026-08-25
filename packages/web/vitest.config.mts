import react from "@vitejs/plugin-react"
import { defineConfig } from "vitest/config"

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./src/tests/setup.ts"],
    restoreMocks: true,
    // Stamps render in the reader's timezone, so the suite fixes one rather than asserting
    // against whichever zone the machine running it happens to be in.
    env: { TZ: "UTC" },
  },
})
