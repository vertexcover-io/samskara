import { execFileSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { applyEnv, readEnvValue } from "./env-file.js"

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..")

export const REQUIRED_CREDENTIALS = ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"] as const

export const missingCredentials = (text: string): ReadonlyArray<string> => {
  if ((readEnvValue(text, "LOCAL_LOGIN_SECRET") ?? "").length > 0) return []
  return REQUIRED_CREDENTIALS.filter((key) => (readEnvValue(text, key) ?? "").length === 0)
}

/** Only fills blanks: re-running setup must never rotate a secret that already signs live cookies. */
export const fillGeneratedSecrets = (
  text: string,
  generate: () => string,
): { readonly text: string; readonly generated: ReadonlyArray<string> } => {
  const blank = ["JWT_SECRET"].filter((key) => (readEnvValue(text, key) ?? "").length === 0)
  if (blank.length === 0) return { text, generated: [] }
  const overrides = Object.fromEntries(blank.map((key) => [key, generate()]))
  return { text: applyEnv(text, overrides), generated: blank }
}

const run = (command: string, args: ReadonlyArray<string>): void => {
  execFileSync(command, [...args], { cwd: root, stdio: "inherit" })
}

const has = (command: string): boolean => {
  try {
    execFileSync("command", ["-v", command], { stdio: "ignore", shell: "/bin/sh" })
    return true
  } catch {
    return false
  }
}

const OAUTH_HELP = `
Create a GitHub OAuth app: Settings -> Developer settings -> OAuth Apps -> New OAuth App

  Homepage URL                  http://localhost:8000
  Authorization callback URL    http://localhost:3000/api/auth/github/callback

Put the client id and a generated secret into .env, then run bun run setup again.`

const main = (): void => {
  const orgSlug = process.argv.slice(2).find((arg) => !arg.startsWith("--"))
  const envPath = join(root, ".env")

  console.log("> installing dependencies")
  run("bun", ["install"])

  if (!existsSync(envPath)) {
    copyFileSync(join(root, ".env.example"), envPath)
    console.log("> created .env from .env.example")
  }

  const filled = fillGeneratedSecrets(readFileSync(envPath, "utf8"), () =>
    randomBytes(32).toString("hex"),
  )
  if (filled.generated.length > 0) {
    writeFileSync(envPath, filled.text)
    console.log(`> generated ${filled.generated.join(", ")}`)
  }

  const missing = missingCredentials(filled.text)
  if (missing.length > 0) {
    console.error(`\n.env is missing ${missing.join(" and ")}.${OAUTH_HELP}`)
    process.exit(1)
  }

  console.log("> starting postgres")
  run("docker", ["compose", "up", "-d", "--wait"])

  console.log("> migrating")
  run("bun", ["run", "db:migrate"])

  console.log("> seeding")
  run("bun", ["run", "seed", "--if-empty"])

  if (orgSlug) run("bun", ["run", "seed:org", orgSlug])

  // Once you have signed in, this database holds the user rows a worktree needs. Capturing here
  // keeps the snapshot current without anyone having to remember a separate command.
  console.log("> capturing identity snapshot")
  run("bun", ["run", "seed:capture"])

  const next = [
    "",
    "Setup done. Next:",
    "",
    "  bun run dev            then open http://localhost:8000",
  ]
  if (!orgSlug) {
    next.push(
      "",
      "Login is gated to members of a registered org -- register yours with:",
      "",
      "  bun run seed:org YOUR_GITHUB_ORG_SLUG",
    )
  }
  if (!has("wt")) {
    next.push(
      "",
      "To work on several branches at once, each with its own database and ports:",
      "",
      "  brew install worktrunk && wt config shell install",
    )
  }
  console.log(next.join("\n"))
}

if (import.meta.url === `file://${process.argv[1]}`) main()
