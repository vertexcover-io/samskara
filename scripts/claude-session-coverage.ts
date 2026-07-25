import { homedir } from "node:os"
import { join } from "node:path"
import { buildClaudeSessionCoverage } from "../packages/core/src/collector/claude-session-coverage.js"

const [sessionId, discoveryRoot = join(homedir(), ".claude", "projects")] = process.argv.slice(2)
if (!sessionId) {
  console.error("Usage: bun run test:claude-session <sessionId> [discoveryRoot]")
  process.exit(1)
}

try {
  const report = await buildClaudeSessionCoverage({ sessionId, discoveryRoot })
  console.log(JSON.stringify(report, null, 2))
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
