import { execFileSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { fileURLToPath } from "node:url"
import postgres from "postgres"

const RUN_DATABASE = /^samskara_e2e_[a-z0-9_]+$/
const serverDir = fileURLToPath(new URL("../packages/server", import.meta.url))

export type RunDisposition =
  | { readonly kind: "drop" }
  | { readonly kind: "keep"; readonly notice: string }

// No fallback: a fallback would point a stray `playwright test` at the development database and
// say nothing about it.
export const requireDatabaseUrl = (): string => {
  const url = process.env.DATABASE_URL
  if (url === undefined || url === "") {
    throw new Error("DATABASE_URL is unset. Start the suite with `bun run e2e`.")
  }
  return url
}

// The maintenance database, never `samskara`: a leaked default can create and drop databases here
// but cannot reach application rows.
export const adminUrl = (): string =>
  process.env.SAMSKARA_E2E_ADMIN_URL ?? "postgres://samskara:samskara@localhost:5433/postgres"

export const runDatabaseName = (): string =>
  `samskara_e2e_${process.pid}_${randomBytes(3).toString("hex")}`

export const isRunDatabaseName = (name: string): boolean => RUN_DATABASE.test(name)

export const dispositionFor = (exitCode: number, url: string): RunDisposition =>
  exitCode === 0
    ? { kind: "drop" }
    : { kind: "keep", notice: `the run database is kept for inspection: psql "${url}"` }

// A database name cannot be a bound parameter in DDL, so it is always interpolated. This guard is
// the only thing between this file and a `drop database samskara`.
const quoted = (name: string): string => {
  if (!isRunDatabaseName(name)) throw new Error(`refusing to touch database: ${name}`)
  return `"${name}"`
}

export const databaseUrlFor = (admin: string, name: string): string => {
  const url = new URL(admin)
  url.pathname = `/${name}`
  return url.toString()
}

export const migrateTo = (url: string): void => {
  execFileSync("bun", ["run", "db:migrate"], {
    cwd: serverDir,
    env: { ...process.env, DATABASE_URL: url },
    stdio: "inherit",
  })
}

export const createRunDatabase = async (admin: string, name: string): Promise<void> => {
  const sql = postgres(admin, { max: 1 })
  try {
    await sql.unsafe(`create database ${quoted(name)}`)
  } finally {
    await sql.end()
  }
}

export const dropRunDatabase = async (admin: string, name: string): Promise<void> => {
  // `if exists` makes the absent case correct, so its NOTICE is noise rather than a signal.
  const sql = postgres(admin, { max: 1, onnotice: () => {} })
  try {
    await sql.unsafe(`drop database if exists ${quoted(name)} with (force)`)
  } finally {
    await sql.end()
  }
}

export const sweepAbandoned = async (admin: string): Promise<ReadonlyArray<string>> => {
  const sql = postgres(admin, { max: 1 })
  try {
    // This is the suite's first touch of the cluster, so a failure here means Postgres is down
    // rather than a bad query, and the message has to name the fix.
    const rows = await sql<{ datname: string }[]>`
      select d.datname from pg_database d
      where d.datname like 'samskara_e2e_%'
        and not exists (select 1 from pg_stat_activity a where a.datname = d.datname)
    `.catch((cause: unknown) => {
      throw new Error(`cannot reach Postgres at ${admin}. Run \`bun run stack:up\` first.`, {
        cause,
      })
    })

    // `_` is a single-character wildcard in `like`, so the pattern above also matches a name such
    // as `samskaraXe2eYdecoy`. The guard below is the safety check; the pattern is only a filter.
    const dropped: string[] = []
    for (const row of rows) {
      if (!isRunDatabaseName(row.datname)) continue
      await sql.unsafe(`drop database if exists ${quoted(row.datname)} with (force)`)
      dropped.push(row.datname)
    }
    return dropped
  } finally {
    await sql.end()
  }
}
