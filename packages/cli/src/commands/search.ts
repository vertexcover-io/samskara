import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { z } from "zod"
import { atomicWriteJson, readJson } from "../config/atomic.js"
import { readToken } from "../config/credentials.js"
import { filterOptionsPath } from "../config/paths.js"
import { getProject } from "../config/projects.js"
import { apiBase, webBase } from "../config.js"
import { runGitOrNull } from "../git.js"
import { errorMessage, relativeTime, resolveIo, type Writer } from "../io.js"
import { resolveProject } from "../watcher/resolveProject.js"
export type SearchFlags = {
  readonly query?: string
  readonly project?: string
  readonly user?: string
  readonly repo?: string
  readonly branch?: string
  readonly pr?: string
  readonly commit?: string
  readonly aiReview?: string
  readonly range?: string
  readonly from?: string
  readonly to?: string
  readonly tz?: string
  readonly sort?: string
  readonly page?: string
  readonly limit?: string
}

// Hand-mirrors `serializeFilters` in packages/web/src/sessions/filters.ts, field for field, so a
// CLI search and a UI search produce the same query string. They are copies rather than one shared
// function because packages/web depends on no workspace package today. Change one, change both.
export const searchQuery = (flags: SearchFlags): URLSearchParams => {
  const custom = flags.range === "custom"
  const sort = flags.sort ?? (flags.query === undefined ? "recent" : "relevance")
  const entries: ReadonlyArray<readonly [string, string | undefined]> = [
    ["q", flags.query],
    ["project", flags.project],
    ["user", flags.user],
    ["repo", flags.repo],
    ["branch", flags.branch],
    ["pr", flags.pr],
    ["commit", flags.commit?.toLowerCase()],
    ["aiReview", flags.aiReview],
    ["range", flags.range === "all" ? undefined : flags.range],
    ["from", custom ? flags.from : undefined],
    ["to", custom ? flags.to : undefined],
    ["tz", custom || flags.range === "today" ? flags.tz : undefined],
    ["sort", sort === "recent" ? undefined : sort],
    ["page", flags.page],
    ["limit", flags.limit],
  ]
  return new URLSearchParams(
    entries.flatMap(
      ([key, value]): ReadonlyArray<[string, string]> =>
        value === undefined ? [] : [[key, value]],
    ),
  )
}

export type NamedOption = {
  readonly value: string
  readonly names: ReadonlyArray<string>
}

/** Every step here either produces something or explains itself, so they share one shape. */
type Outcome<T> = ({ readonly ok: true } & T) | { readonly ok: false; readonly message: string }

export type Resolution = Outcome<{ readonly value: string }>

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const SHOWN = 8

const labels = (options: ReadonlyArray<NamedOption>): string =>
  options.map((option) => option.names[0] ?? option.value).join(", ")

const sharedPrefix = (a: string, b: string): number => {
  let length = 0
  while (length < a.length && length < b.length && a[length] === b[length]) length += 1
  return length
}

// Scores how close a name is to what was typed: how many leading characters they share.
// "samskra" and "Samskara Server" share "samsk", so that scores 5.
const closeness = (option: NamedOption, wanted: string): number =>
  Math.max(0, ...option.names.map((name) => sharedPrefix(name.toLowerCase(), wanted)))

// Sort by that score before trimming to eight, so a typo is shown the name it nearly matched
// rather than whichever eight names happen to sort first.
const known = (options: ReadonlyArray<NamedOption>, wanted: string): string => {
  const ranked = [...options].sort((a, b) => closeness(b, wanted) - closeness(a, wanted))
  const rest = ranked.length - SHOWN
  const shown = labels(ranked.slice(0, SHOWN))
  return rest > 0 ? `${shown} and ${rest} more.` : `${shown}.`
}

export const resolveOption = (params: {
  readonly flag: string
  readonly input: string
  readonly options: ReadonlyArray<NamedOption>
}): Resolution => {
  if (UUID.test(params.input)) return { ok: true, value: params.input }

  const wanted = params.input.trim().toLowerCase()
  const exact = params.options.filter((option) =>
    option.names.some((name) => name.toLowerCase() === wanted),
  )
  const first = exact[0]
  if (first !== undefined) return { ok: true, value: first.value }

  const partial = params.options.filter((option) =>
    option.names.some((name) => name.toLowerCase().includes(wanted)),
  )
  const only = partial[0]
  if (only !== undefined && partial.length === 1) return { ok: true, value: only.value }
  if (partial.length > 1) {
    return {
      ok: false,
      message: `${params.flag} ${params.input} matches more than one: ${labels(partial)}. Use a more exact name.`,
    }
  }
  return {
    ok: false,
    message: `${params.flag} ${params.input} matched nothing. Known values: ${known(params.options, wanted)}`,
  }
}

export type SessionRow = {
  readonly id: string
  readonly title: string | null
  readonly projectName: string
  readonly userLogin: string
  readonly repo: { readonly owner: string; readonly repoName: string } | null
  readonly tokensTotal: number
  readonly lastActiveAt: string
}

const DOT = "·"

const tokens = (total: number): string =>
  total < 1000 ? `${total} tokens` : `${Math.round(total / 1000)}k tokens`

export const sessionUrl = (webBase: string, id: string): string => `${webBase}/sessions/${id}`

const searchUrl = (webBase: string, query: URLSearchParams): string => {
  const rest = query.toString()
  return rest === "" ? `${webBase}/sessions` : `${webBase}/sessions?${rest}`
}

const facts = (row: SessionRow, now: Date): ReadonlyArray<string> => [
  row.projectName,
  ...(row.repo === null ? [] : [`${row.repo.owner}/${row.repo.repoName}`]),
  row.userLogin,
  tokens(row.tokensTotal),
  relativeTime(row.lastActiveAt, now),
]

export const renderResults = (params: {
  readonly rows: ReadonlyArray<SessionRow>
  readonly total: number
  readonly webBase: string
  readonly query: URLSearchParams
  readonly now: Date
}): string => {
  const blocks = params.rows.map((row) =>
    [
      `  ${row.title ?? "(untitled)"}`,
      `  ${facts(row, params.now).join(` ${DOT} `)}`,
      `  ${sessionUrl(params.webBase, row.id)}`,
    ].join("\n"),
  )
  const body = blocks.length === 0 ? ["  No sessions matched."] : blocks
  const footer = `  ${params.rows.length} of ${params.total} ${DOT} ${searchUrl(params.webBase, params.query)}`
  return ["", ...body, "", footer, ""].join("\n")
}

export type SearchOptions = SearchFlags & {
  readonly url?: boolean
  readonly json?: boolean
  readonly first?: boolean
  readonly open?: boolean
  readonly here?: boolean
}

export type SearchDeps = {
  readonly fetch: typeof globalThis.fetch
  readonly now?: () => Date
  readonly stdout?: Writer
  readonly stderr?: Writer
}

export type HereFilters = {
  readonly project?: string
  readonly repo?: string
  readonly branch?: string
}

const optionSchema = z.object({ value: z.string(), label: z.string() })

const listingSchema = z.object({
  // `loose` keeps fields this schema does not name, so --json can hand back everything the
  // server sent rather than only the handful the table prints.
  sessions: z.array(
    z
      .object({
        id: z.string(),
        title: z.string().nullable(),
        projectName: z.string(),
        userLogin: z.string(),
        repo: z.object({ owner: z.string(), repoName: z.string() }).loose().nullable(),
        tokensTotal: z.number(),
        lastActiveAt: z.string(),
      })
      .loose(),
  ),
  pagination: z.object({ total: z.number() }),
  filterOptions: z.object({
    projects: z.array(optionSchema),
    authors: z.array(optionSchema),
    repositories: z.array(optionSchema.extend({ repoName: z.string() })),
    branches: z.array(z.string()),
  }),
})

// The server refuses with codes like `invalidPrNumber`. Turn each one into a sentence that
// names the flag at fault and what it accepts.
const REFUSALS: Readonly<Record<string, string>> = {
  invalidSearchQuery: "The search text is not a query this server accepts.",
  invalidProject: "--project is not a project id this server accepts.",
  invalidUser: "--user takes a GitHub login.",
  invalidRepo: "--repo is not a repository id this server accepts.",
  invalidBranch: "--branch is not a branch name this server accepts.",
  invalidPrNumber: "--pr takes a pull request number, like --pr 17.",
  invalidCommit: "--commit takes 7 to 40 hex characters of a commit sha.",
  invalidAiReview: "--ai-review takes done or missing.",
  ambiguousCommit: "--commit matches several commits. Give more of it.",
  invalidRange: "--range takes all, hour, today, week, month or custom.",
  invalidSort: "--sort takes relevance, recent, oldest, tokens or project.",
  invalidTimeZone: "--tz takes an IANA time zone, like --tz Asia/Kolkata.",
  invalidPage: "--page takes a whole number from 1 up.",
  invalidLimit: "--limit takes a whole number from 1 to 100.",
  invalidFilter: "One of the filters is not a value this server accepts.",
  projectNotFound: "--project names a project this account cannot see.",
  unauthorized: "The server rejected this CLI token. Run `samskara login` again.",
}

const refusalSchema = z.object({ error: z.string() })

const refusal = async (res: Response): Promise<string> => {
  const parsed = refusalSchema.safeParse(await res.json().catch(() => null))
  if (!parsed.success) return `The server refused the search with status ${res.status}.`
  return REFUSALS[parsed.data.error] ?? `The server refused the search: ${parsed.data.error}.`
}

type Listing = z.infer<typeof listingSchema>

type Loaded = Outcome<{ readonly listing: Listing }>

const load = async (params: {
  readonly deps: SearchDeps
  readonly query: URLSearchParams
  readonly token: string
  readonly now: Date
}): Promise<Loaded> => {
  // A thrown fetch means the server could not be reached at all, which is different from a
  // server that answered with an error. Uncaught, it would surface as a stack trace.
  const res = await params.deps
    .fetch(`${apiBase()}/api/sessions?${params.query.toString()}`, {
      headers: { authorization: `Bearer ${params.token}` },
    })
    .catch(() => null)
  if (res === null) return { ok: false, message: `Could not reach ${apiBase()}.` }
  if (!res.ok) return { ok: false, message: await refusal(res) }

  const listing = listingSchema.parse(await res.json())
  // Safe to cache from any response: the server builds filterOptions from the account asking, not
  // from the filters asked for, so even a narrow search returns the whole list.
  await atomicWriteJson(filterOptionsPath(), {
    apiBase: apiBase(),
    fetchedAt: params.now.getTime(),
    filterOptions: listing.filterOptions,
  }).catch(() => {})
  return { ok: true, listing }
}

const needsLookup = (value: string | undefined): boolean => value !== undefined && !UUID.test(value)

type FilterOptions = Listing["filterOptions"]

const namedProjects = (filterOptions: FilterOptions): ReadonlyArray<NamedOption> =>
  filterOptions.projects.map((option) => ({ value: option.value, names: [option.label] }))

// A repo can be named either way: `acme/samskara` or just `samskara`.
const namedRepos = (filterOptions: FilterOptions): ReadonlyArray<NamedOption> =>
  filterOptions.repositories.map((option) => ({
    value: option.value,
    names: [option.label, option.repoName],
  }))

type Resolved = Outcome<{ readonly flags: SearchFlags }>

const resolveAgainst = (options: SearchOptions, filterOptions: FilterOptions): Resolved => {
  const project =
    options.project === undefined
      ? null
      : resolveOption({
          flag: "--project",
          input: options.project,
          options: namedProjects(filterOptions),
        })
  if (project !== null && !project.ok) return project

  const repo =
    options.repo === undefined
      ? null
      : resolveOption({ flag: "--repo", input: options.repo, options: namedRepos(filterOptions) })
  if (repo !== null && !repo.ok) return repo

  return {
    ok: true,
    flags: {
      ...options,
      ...(project === null ? {} : { project: project.value }),
      ...(repo === null ? {} : { repo: repo.value }),
    },
  }
}

const CACHE_TTL_MS = 5 * 60_000

const cacheSchema = z.object({
  apiBase: z.string(),
  fetchedAt: z.number(),
  filterOptions: listingSchema.shape.filterOptions,
})

const cachedOptions = async (now: Date): Promise<FilterOptions | null> => {
  const parsed = cacheSchema.safeParse(await readJson(filterOptionsPath()).catch(() => null))
  if (!parsed.success) return null
  if (parsed.data.apiBase !== apiBase()) return null
  if (now.getTime() - parsed.data.fetchedAt > CACHE_TTL_MS) return null
  return parsed.data.filterOptions
}

const resolveNames = async (
  options: SearchOptions,
  deps: SearchDeps,
  now: Date,
  token: string,
): Promise<Resolved> => {
  if (!needsLookup(options.project) && !needsLookup(options.repo)) {
    return { ok: true, flags: options }
  }

  // If the cached list does not contain the name, ask the server again before giving up. A
  // project created in the last few minutes is not in the cache yet, and must not look missing.
  const cached = await cachedOptions(now)
  if (cached !== null) {
    const attempt = resolveAgainst(options, cached)
    if (attempt.ok) return attempt
  }

  // This request sends no filters, only `limit=1`. It exists to fetch the name-to-id list, and
  // sending the unresolved name here is what the server would reject.
  const probe = await load({ deps, query: new URLSearchParams({ limit: "1" }), token, now })
  if (!probe.ok) return probe
  return resolveAgainst(options, probe.listing.filterOptions)
}

// `open` on macOS, `xdg-open` on Linux, `start` through cmd on Windows.
const openInBrowser = async (url: string): Promise<void> => {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open"
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url]
  await promisify(execFile)(command, args)
}

export const searchCommand = async (options: SearchOptions, deps: SearchDeps): Promise<number> => {
  const { stdout, stderr } = resolveIo(deps)
  const now = (deps.now ?? (() => new Date()))()

  const token = await readToken()
  if (token === null) {
    stderr.write("Not paired with a server. Run `samskara login` first.\n")
    return 1
  }

  const here = options.here === true ? await hereFilters(process.cwd()) : {}
  // `here` and the time zone are only defaults, which is why they are spread first: anything
  // typed on the command line overwrites them. `today` then means today where the person is.
  const tz = options.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  const resolved = await resolveNames({ ...here, ...options, tz }, deps, now, token)
  if (!resolved.ok) {
    stderr.write(`${resolved.message}\n`)
    return 1
  }

  const query = searchQuery(resolved.flags)
  const result = await load({ deps, query, token, now })
  if (!result.ok) {
    stderr.write(`${result.message}\n`)
    return 1
  }
  const { listing } = result

  const rows = options.first === true ? listing.sessions.slice(0, 1) : listing.sessions

  if (options.open === true) {
    const top = rows[0]
    if (top === undefined) {
      stderr.write("No sessions matched, so there is nothing to open.\n")
      return 1
    }
    const url = sessionUrl(webBase(), top.id)
    const failure = await openInBrowser(url).then(
      () => null,
      (error: unknown) => errorMessage(error),
    )
    if (failure !== null) {
      stderr.write(`Could not open a browser (${failure}). The session is at ${url}\n`)
      return 1
    }
    stdout.write(`${url}\n`)
    return 0
  }

  if (options.json === true) {
    stdout.write(
      `${JSON.stringify(
        {
          total: listing.pagination.total,
          searchUrl: searchUrl(webBase(), query),
          sessions: rows.map((row) => ({ ...row, url: sessionUrl(webBase(), row.id) })),
        },
        null,
        2,
      )}\n`,
    )
    return 0
  }

  if (options.url === true) {
    stdout.write(rows.map((row) => `${sessionUrl(webBase(), row.id)}\n`).join(""))
    return 0
  }

  stdout.write(
    renderResults({ rows, total: listing.pagination.total, webBase: webBase(), query, now }),
  )
  return 0
}

/**
 * `--here` reads the checkout, not the server: the registry already stores the project id this
 * folder uploads to, and git is the only thing that knows which branch is checked out now.
 */
export const hereFilters = async (cwd: string): Promise<HereFilters> => {
  const [identity, branch] = await Promise.all([
    resolveProject(cwd),
    runGitOrNull(["rev-parse", "--abbrev-ref", "HEAD"], cwd),
  ])
  const registered = identity === null ? null : await getProject(identity.slug)
  return {
    ...(registered?.projectId === undefined ? {} : { project: registered.projectId }),
    ...(identity?.remote === undefined
      ? {}
      : { repo: `${identity.remote.owner}/${identity.remote.repoName}` }),
    ...(branch === null || branch === "HEAD" ? {} : { branch }),
  }
}
