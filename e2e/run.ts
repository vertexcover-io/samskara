import { spawn } from "node:child_process"
import {
  adminUrl,
  createRunDatabase,
  databaseUrlFor,
  dispositionFor,
  dropRunDatabase,
  migrateTo,
  runDatabaseName,
  sweepAbandoned,
} from "./db.js"

// This process is the one that sets DATABASE_URL, so it must never read it: the config module,
// both webServer children, and every worker inherit the value from here.
const playwright = (url: string, args: ReadonlyArray<string>): Promise<number> =>
  new Promise((resolve) => {
    const child = spawn(
      "bun",
      ["x", "playwright", "test", "-c", "e2e/playwright.config.ts", ...args],
      { stdio: "inherit", env: { ...process.env, DATABASE_URL: url } },
    )
    child.on("exit", (code) => resolve(code ?? 1))
  })

const main = async (): Promise<number> => {
  const admin = adminUrl()

  // Sweep before creating, not after running: a run killed with SIGKILL cannot clean up after
  // itself, so the next run is what removes it.
  const abandoned = await sweepAbandoned(admin)
  if (abandoned.length > 0) console.log(`dropped ${abandoned.length} abandoned e2e database(s)`)

  const name = runDatabaseName()
  const url = databaseUrlFor(admin, name)
  await createRunDatabase(admin, name)

  try {
    migrateTo(url)
  } catch (cause) {
    await dropRunDatabase(admin, name)
    throw new Error(`migrations failed against ${name}`, { cause })
  }

  const code = await playwright(url, process.argv.slice(2))
  const disposition = dispositionFor(code, url)
  if (disposition.kind === "drop") await dropRunDatabase(admin, name)
  else console.log(`\n${disposition.notice}`)
  return code
}

process.exit(await main())
