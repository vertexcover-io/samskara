import { execFileSync } from "node:child_process"
import { copyFileSync, existsSync, lstatSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import postgres from "postgres"
import { applyEnv, definesScript, readEnvValue } from "./env-file.js"

const BASE_SERVER_PORT = 3000
const BASE_WEB_PORT = 8000
const OFFSET_SPAN = 400
const MAX_SLUG = 40

/** 100 is the orchestrate/e2e stack's pair (3100/8100); handing it to a branch would collide. */
export const RESERVED_OFFSETS: ReadonlySet<number> = new Set([100])

export const slugify = (branch: string): string => {
  const cleaned = branch
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
  const truncated = cleaned.slice(0, MAX_SLUG).replace(/_+$/, "")
  return truncated || "wt"
}

export const databaseName = (slug: string): string => `samskara_${slug}`

export const replaceDatabase = (url: string, database: string): string => {
  const parsed = new URL(url)
  parsed.pathname = `/${database}`
  return parsed.toString()
}

/** FNV-1a: a stable starting point so the same branch keeps the same ports across runs. */
const hash = (value: string): number => {
  let acc = 2166136261
  for (let i = 0; i < value.length; i += 1) {
    acc ^= value.charCodeAt(i)
    acc = Math.imul(acc, 16777619) >>> 0
  }
  return acc >>> 0
}

/**
 * Hashing alone would silently hand two branches the same pair of ports, and the second app to
 * start would just fail to bind. `taken` carries the offsets sibling worktrees already recorded,
 * so a collision walks forward instead — still deterministic, because the winner keeps its offset.
 */
export const pickOffset = (slug: string, taken: ReadonlySet<number>): number => {
  const start = hash(slug) % OFFSET_SPAN
  for (let step = 0; step < OFFSET_SPAN; step += 1) {
    const candidate = ((start + step) % OFFSET_SPAN) + 1
    if (!taken.has(candidate) && !RESERVED_OFFSETS.has(candidate)) return candidate
  }
  throw new Error(`no free port offset left for ${slug}`)
}

export type WorktreeEnv = {
  readonly DATABASE_URL: string
  readonly PORT: string
  readonly WEB_PORT: string
  readonly API_PROXY_TARGET: string
  readonly PUBLIC_BASE_URL: string
  readonly VITE_API_BASE_URL: string
  readonly WEB_BASE_URL: string
  readonly WT_SLUG: string
  readonly WT_PORT_OFFSET: string
}

export const worktreeEnv = (params: {
  readonly baseDatabaseUrl: string
  readonly slug: string
  readonly offset: number
}): WorktreeEnv => {
  const serverPort = BASE_SERVER_PORT + params.offset
  const webPort = BASE_WEB_PORT + params.offset
  const api = `http://localhost:${serverPort}`
  return {
    DATABASE_URL: replaceDatabase(params.baseDatabaseUrl, databaseName(params.slug)),
    PORT: String(serverPort),
    WEB_PORT: String(webPort),
    API_PROXY_TARGET: api,
    PUBLIC_BASE_URL: api,
    VITE_API_BASE_URL: api,
    WEB_BASE_URL: `http://localhost:${webPort}`,
    WT_SLUG: params.slug,
    WT_PORT_OFFSET: String(params.offset),
  }
}

// stderr ignored: callers handle a failure by falling back, and git's own message ("ambiguous
// argument 'HEAD'" in a repo with no commits) reads like a crash when it is an expected branch.
const git = (args: ReadonlyArray<string>, cwd: string): string =>
  execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim()

type Worktree = { readonly path: string; readonly branch: string }

export const parseWorktreeList = (porcelain: string): ReadonlyArray<Worktree> =>
  porcelain
    .split("\n\n")
    .map((block) => {
      const path = /^worktree (.+)$/m.exec(block)?.[1]
      const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1]
      return path ? { path, branch: branch ?? "" } : null
    })
    .filter((entry): entry is Worktree => entry !== null)

/**
 * A worktree created by the harness skill gets `.env` as a symlink back to the main checkout, so
 * every branch reads one DATABASE_URL. Replacing the link with a real copy is what makes the rest
 * of this script possible -- editing through the link would rewrite the main checkout's env.
 */
const materializeEnv = (envPath: string, sourceEnvPath: string): void => {
  if (existsSync(envPath) && !lstatSync(envPath).isSymbolicLink()) return
  if (existsSync(envPath)) rmSync(envPath)
  copyFileSync(sourceEnvPath, envPath)
}

const ensureDatabase = async (adminUrl: string, database: string): Promise<boolean> => {
  const sql = postgres(adminUrl, { max: 1 })
  try {
    const existing = await sql`select 1 from pg_database where datname = ${database}`
    if (existing.length > 0) return false
    await sql.unsafe(`create database "${database}"`)
    return true
  } finally {
    await sql.end()
  }
}

const dropDatabase = async (adminUrl: string, database: string): Promise<boolean> => {
  const sql = postgres(adminUrl, { max: 1 })
  try {
    const existing = await sql`select 1 from pg_database where datname = ${database}`
    if (existing.length === 0) return false
    await sql.unsafe(`drop database "${database}" with (force)`)
    return true
  } finally {
    await sql.end()
  }
}

const run = (script: string, cwd: string, databaseUrl: string): void => {
  execFileSync("bun", ["run", script], {
    cwd,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: "inherit",
  })
}

type Layout = {
  readonly root: string
  readonly mainRoot: string
  readonly branch: string
  readonly siblings: ReadonlyArray<Worktree>
}

const readLayout = (): Layout => {
  const root = git(["rev-parse", "--show-toplevel"], process.cwd())
  const worktrees = parseWorktreeList(git(["worktree", "list", "--porcelain"], root))
  const mainRoot = worktrees[0]?.path ?? root
  return {
    root,
    mainRoot,
    branch: git(["rev-parse", "--abbrev-ref", "HEAD"], root),
    siblings: worktrees.filter((entry) => entry.path !== root && entry.path !== mainRoot),
  }
}

const takenOffsets = (siblings: ReadonlyArray<Worktree>): ReadonlySet<number> => {
  const offsets = siblings.flatMap((sibling) => {
    const envPath = join(sibling.path, ".env")
    if (!existsSync(envPath) || lstatSync(envPath).isSymbolicLink()) return []
    const raw = readEnvValue(readFileSync(envPath, "utf8"), "WT_PORT_OFFSET")
    const parsed = Number(raw)
    return raw && Number.isInteger(parsed) ? [parsed] : []
  })
  return new Set(offsets)
}

/** The main checkout's env is the source of truth for identities worth copying into a worktree. */
export const readMainDatabaseUrl = (): string => {
  const layout = readLayout()
  const envPath = join(layout.mainRoot, ".env")
  const url = readEnvValue(readFileSync(envPath, "utf8"), "DATABASE_URL")
  if (!url) throw new Error(`DATABASE_URL missing from ${envPath}`)
  return url
}

export const mainEnvPath = (): string => join(readLayout().mainRoot, ".env")

const setup = async (layout: Layout): Promise<void> => {
  const envPath = join(layout.root, ".env")
  const sourceEnvPath = join(layout.mainRoot, ".env")
  if (!existsSync(sourceEnvPath)) throw new Error(`no .env in the main checkout: ${sourceEnvPath}`)
  materializeEnv(envPath, sourceEnvPath)

  const baseDatabaseUrl = readEnvValue(readFileSync(sourceEnvPath, "utf8"), "DATABASE_URL")
  if (!baseDatabaseUrl) throw new Error(`DATABASE_URL missing from ${sourceEnvPath}`)

  const slug = slugify(layout.branch)
  const current = readEnvValue(readFileSync(envPath, "utf8"), "WT_PORT_OFFSET")
  const offset =
    current && Number.isInteger(Number(current))
      ? Number(current)
      : pickOffset(slug, takenOffsets(layout.siblings))

  const env = worktreeEnv({ baseDatabaseUrl, slug, offset })
  writeFileSync(envPath, applyEnv(readFileSync(envPath, "utf8"), env))

  const database = databaseName(slug)
  const created = await ensureDatabase(replaceDatabase(baseDatabaseUrl, "postgres"), database)
  console.log(`${created ? "created" : "reusing"} database ${database}`)

  run("db:migrate", layout.root, env.DATABASE_URL)
  const packageJson = readFileSync(join(layout.root, "package.json"), "utf8")
  // Migrations ship the search helper functions; the GIN indexes over them are a separate step and
  // a worktree without them makes every search scan the whole message table.
  if (definesScript(packageJson, "db:index-search"))
    run("db:index-search", layout.root, env.DATABASE_URL)
  if (definesScript(packageJson, "seed:dev")) run("seed:dev", layout.root, env.DATABASE_URL)
  else console.log("this branch has no seed:dev script -- database left empty")

  console.log(
    [
      `worktree ${layout.branch} ready`,
      `  db   ${env.DATABASE_URL}`,
      `  api  ${env.PUBLIC_BASE_URL}`,
      `  web  ${env.WEB_BASE_URL}`,
    ].join("\n"),
  )
}

const teardown = async (layout: Layout): Promise<void> => {
  const sourceEnvPath = join(layout.mainRoot, ".env")
  const baseDatabaseUrl = readEnvValue(readFileSync(sourceEnvPath, "utf8"), "DATABASE_URL")
  if (!baseDatabaseUrl) throw new Error(`DATABASE_URL missing from ${sourceEnvPath}`)
  const database = databaseName(slugify(layout.branch))
  const dropped = await dropDatabase(replaceDatabase(baseDatabaseUrl, "postgres"), database)
  console.log(dropped ? `dropped database ${database}` : `no database ${database} to drop`)
}

const main = async (): Promise<void> => {
  const layout = readLayout()
  if (layout.root === layout.mainRoot) {
    console.log("main checkout -- leaving .env and the samskara database alone")
    return
  }
  await (process.argv.includes("--drop") ? teardown(layout) : setup(layout))
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
