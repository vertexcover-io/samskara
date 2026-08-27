import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { atomicWriteJson, readJson } from "../config/atomic.js"
import { filterOptionsPath } from "../config/paths.js"
import { getProject } from "../config/projects.js"
import { apiBase as resolveApiBase, webBase as resolveWebBase } from "../config.js"
import { runGitOrNull } from "../git.js"

vi.mock("../git.js", () => ({ runGitOrNull: vi.fn(async () => null) }))
vi.mock("../config/projects.js", () => ({ getProject: vi.fn(async () => null) }))

import { hereFilters, renderResults, resolveOption, searchCommand, searchQuery } from "./search.js"

const apiBase = resolveApiBase()
const webBase = resolveWebBase()

const ORIGINAL_HOME = process.env.SAMSKARA_HOME

/** Answers the git calls this suite cares about by their joined args, and null for the rest. */
const gitReturning = (byArgs: Record<string, string | null>) => {
  vi.mocked(runGitOrNull).mockImplementation(async (args) => byArgs[args.join(" ")] ?? null)
}

describe("searchQuery", () => {
  test("a free-text query becomes q and picks the relevance sort the UI picks, adding nothing else", () => {
    expect(searchQuery({ query: "auth bug" }).toString()).toBe("q=auth+bug&sort=relevance")
  })

  test("an explicit sort wins over the query-derived default, and recent stays out the way the UI leaves it out", () => {
    expect(searchQuery({ query: "auth", sort: "tokens" }).toString()).toBe("q=auth&sort=tokens")
    expect(searchQuery({ query: "auth", sort: "recent" }).toString()).toBe("q=auth")
  })

  test("from and to ride along only with a custom range, because every other range computes its own window", () => {
    expect(searchQuery({ range: "custom", from: "2026-01-01", to: "2026-02-01" }).toString()).toBe(
      "range=custom&from=2026-01-01&to=2026-02-01",
    )
    expect(searchQuery({ range: "week", from: "2026-01-01", to: "2026-02-01" }).toString()).toBe(
      "range=week",
    )
  })

  test("the time zone rides along only for today and custom, the two ranges whose window depends on it", () => {
    expect(searchQuery({ range: "today", tz: "Asia/Kolkata" }).toString()).toBe(
      "range=today&tz=Asia%2FKolkata",
    )
    expect(searchQuery({ range: "week", tz: "Asia/Kolkata" }).toString()).toBe("range=week")
  })

  test("every remaining filter passes through in the UI's order, the commit lowercased and range=all left out", () => {
    const params = searchQuery({
      project: "11111111-1111-4111-8111-111111111111",
      user: "kgritesh",
      repo: "22222222-2222-4222-8222-222222222222",
      branch: "master",
      pr: "17",
      commit: "A1B2C3D",
      range: "all",
      page: "3",
      limit: "10",
    })

    expect(params.toString()).toBe(
      "project=11111111-1111-4111-8111-111111111111&user=kgritesh" +
        "&repo=22222222-2222-4222-8222-222222222222&branch=master&pr=17&commit=a1b2c3d" +
        "&page=3&limit=10",
    )
  })
})

describe("resolveOption", () => {
  const PROJECTS = [
    { value: "11111111-1111-4111-8111-111111111111", names: ["Samskara Web"] },
    { value: "22222222-2222-4222-8222-222222222222", names: ["Samskara Server"] },
  ]

  test("a uuid is used as given, so a value copied out of the UI needs no option list at all", () => {
    expect(
      resolveOption({
        flag: "--project",
        input: "99999999-9999-4999-8999-999999999999",
        options: [],
      }),
    ).toEqual({ ok: true, value: "99999999-9999-4999-8999-999999999999" })
  })

  test("a name matches whatever case it is typed in, so `samskara web` finds Samskara Web", () => {
    expect(resolveOption({ flag: "--project", input: "samskara web", options: PROJECTS })).toEqual({
      ok: true,
      value: "11111111-1111-4111-8111-111111111111",
    })
  })

  test("a fragment that fits one option resolves, so a repo can be named without its owner", () => {
    expect(resolveOption({ flag: "--project", input: "server", options: PROJECTS })).toEqual({
      ok: true,
      value: "22222222-2222-4222-8222-222222222222",
    })
  })

  test("a fragment fitting two options refuses instead of silently picking one, and names both", () => {
    expect(resolveOption({ flag: "--project", input: "samskara", options: PROJECTS })).toEqual({
      ok: false,
      message:
        "--project samskara matches more than one: Samskara Web, Samskara Server. Use a more exact name.",
    })
  })

  test("the names offered after a miss are the ones closest to what was typed, not the alphabetical first", () => {
    const many = [
      ...Array.from({ length: 8 }, (_, index) => ({
        value: `id-a${index}`,
        names: [`Aardvark ${index}`],
      })),
      { value: "id-close", names: ["Samskara Server"] },
    ]

    const result = resolveOption({ flag: "--project", input: "samskra", options: many })

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.message).toContain("Samskara Server")
  })

  test("a name matching nothing refuses and shows what there was to choose from, capped at eight", () => {
    const many = Array.from({ length: 10 }, (_, index) => ({
      value: `id-${index}`,
      names: [`Project ${index}`],
    }))

    expect(resolveOption({ flag: "--repo", input: "nope", options: PROJECTS })).toEqual({
      ok: false,
      message: "--repo nope matched nothing. Known values: Samskara Web, Samskara Server.",
    })
    expect(resolveOption({ flag: "--repo", input: "nope", options: many })).toEqual({
      ok: false,
      message:
        "--repo nope matched nothing. Known values: Project 0, Project 1, Project 2, Project 3," +
        " Project 4, Project 5, Project 6, Project 7 and 2 more.",
    })
  })
})

describe("renderResults", () => {
  const NOW = new Date("2026-08-24T12:00:00.000Z")
  const ROW = {
    id: "a1b2c3d4-0000-4000-8000-000000000001",
    title: "Fixing the auth redirect loop",
    projectName: "Samskara Web",
    userLogin: "kgritesh",
    repo: { owner: "vertexcover-io", repoName: "samskara" },
    tokensTotal: 142_000,
    lastActiveAt: "2026-08-24T10:00:00.000Z",
  }

  test("a hit shows its title, its facts and its own url, under a footer counting it against the total", () => {
    expect(
      renderResults({
        rows: [ROW],
        total: 7,
        webBase: "http://localhost:8000",
        query: new URLSearchParams("q=auth"),
        now: NOW,
      }),
    ).toBe(
      [
        "",
        "  Fixing the auth redirect loop",
        "  Samskara Web \u00b7 vertexcover-io/samskara \u00b7 kgritesh \u00b7 142k tokens \u00b7 2h ago",
        "  http://localhost:8000/sessions/a1b2c3d4-0000-4000-8000-000000000001",
        "",
        "  1 of 7 \u00b7 http://localhost:8000/sessions?q=auth",
        "",
      ].join("\n"),
    )
  })

  test("no hits says so plainly and still offers the same search in the UI", () => {
    expect(
      renderResults({
        rows: [],
        total: 0,
        webBase: "http://localhost:8000",
        query: new URLSearchParams("branch=master"),
        now: NOW,
      }),
    ).toBe(
      [
        "",
        "  No sessions matched.",
        "",
        "  0 of 0 \u00b7 http://localhost:8000/sessions?branch=master",
        "",
      ].join("\n"),
    )
  })

  test("a session with no title and no repo still renders, dropping the repo fact rather than a blank one", () => {
    const lines = renderResults({
      rows: [{ ...ROW, title: null, repo: null }],
      total: 1,
      webBase: "http://localhost:8000",
      query: new URLSearchParams(),
      now: NOW,
    }).split("\n")

    expect(lines[1]).toBe("  (untitled)")
    expect(lines[2]).toBe("  Samskara Web \u00b7 kgritesh \u00b7 142k tokens \u00b7 2h ago")
  })
})

const NO_OPTIONS = { projects: [], authors: [], repositories: [], branches: [] }

const PAYLOAD_ROW = {
  id: "a1b2c3d4-0000-4000-8000-000000000001",
  title: "Fixing the auth redirect loop",
  projectName: "Samskara Web",
  userLogin: "kgritesh",
  repo: { host: "github.com", owner: "vertexcover-io", repoName: "samskara" },
  tokensTotal: 142_000,
  lastActiveAt: "2026-08-24T10:00:00.000Z",
}

type Reply = { readonly status: number; readonly body: unknown }

const stubFetch = (calls: string[], replies: ReadonlyArray<Reply>): typeof globalThis.fetch =>
  (async (input: string | URL | Request) => {
    calls.push(String(input))
    const reply = replies[calls.length - 1] ?? replies[replies.length - 1]
    if (reply === undefined) throw new Error("no reply configured")
    return new Response(JSON.stringify(reply.body), { status: reply.status })
  }) as typeof globalThis.fetch

const listing = (
  rows: ReadonlyArray<unknown>,
  total: number,
  filterOptions: unknown = NO_OPTIONS,
): Reply => ({
  status: 200,
  body: {
    sessions: rows,
    pagination: { page: 1, limit: 50, total, totalPages: 1 },
    filterOptions,
  },
})

describe("searchCommand", () => {
  const NOW = new Date("2026-08-24T12:00:00.000Z")
  const API = `${apiBase}/api/sessions`
  let home: string
  let out: string
  let err: string
  const stdout = {
    write(text: string) {
      out += text
      return true
    },
  }
  const stderr = {
    write(text: string) {
      err += text
      return true
    },
  }

  /** The token and the options cache both live under SAMSKARA_HOME, so a temp one isolates both. */
  const deps = (fetch: typeof globalThis.fetch) => ({ fetch, now: () => NOW, stdout, stderr })

  beforeEach(async () => {
    out = ""
    err = ""
    home = await mkdtemp(join(tmpdir(), "samskara-search-"))
    process.env.SAMSKARA_HOME = home
    await writeFile(join(home, "token"), "cli-token", "utf8")
    vi.mocked(runGitOrNull).mockResolvedValue(null)
    vi.mocked(getProject).mockResolvedValue(null)
  })

  afterEach(() => {
    process.env.SAMSKARA_HOME = ORIGINAL_HOME
  })

  test("asks the server for exactly the UI's query string and prints each hit with its own url", async () => {
    const calls: string[] = []

    const code = await searchCommand(
      { query: "auth" },
      deps(stubFetch(calls, [listing([PAYLOAD_ROW], 7)])),
    )

    expect(calls).toEqual([`${API}?q=auth&sort=relevance`])
    expect(out).toContain("  Fixing the auth redirect loop\n")
    expect(out).toContain(`  ${webBase}/sessions/a1b2c3d4-0000-4000-8000-000000000001\n`)
    expect(out).toContain(`  1 of 7 \u00b7 ${webBase}/sessions?q=auth&sort=relevance\n`)
    expect(code).toBe(0)
  })

  test("with no stored token it says how to pair and never reaches the server", async () => {
    await rm(join(home, "token"), { force: true })
    const calls: string[] = []

    const code = await searchCommand({}, deps(stubFetch(calls, [])))

    expect(calls).toEqual([])
    expect(err).toContain("samskara login")
    expect(code).toBe(1)
  })

  test.each([
    ["invalidPrNumber", 400, "--pr"],
    ["invalidCommit", 400, "--commit"],
    ["ambiguousCommit", 400, "more of it"],
    ["invalidSearchQuery", 400, "search text"],
    ["projectNotFound", 404, "--project"],
    ["unauthorized", 401, "samskara login"],
    ["somethingNew", 400, "somethingNew"],
  ])(
    "the server's %s refusal is reported as a sentence, never as the bare code",
    async (error, status, expected) => {
      const code = await searchCommand({}, deps(stubFetch([], [{ status, body: { error } }])))

      expect(err).toContain(expected)
      expect(code).toBe(1)
    },
  )

  test("a server that cannot be reached is reported as unreachable, not as a stack trace", async () => {
    const code = await searchCommand(
      {},
      deps((async () => {
        throw new TypeError("fetch failed")
      }) as typeof globalThis.fetch),
    )

    expect(err).toContain(apiBase)
    expect(err).not.toContain("TypeError")
    expect(code).toBe(1)
  })

  test("--url prints one url per line and nothing else, so the output pipes into other commands", async () => {
    const second = { ...PAYLOAD_ROW, id: "a1b2c3d4-0000-4000-8000-000000000002" }

    const code = await searchCommand(
      { url: true },
      deps(stubFetch([], [listing([PAYLOAD_ROW, second], 2)])),
    )

    expect(out).toBe(
      `${webBase}/sessions/a1b2c3d4-0000-4000-8000-000000000001\n` +
        `${webBase}/sessions/a1b2c3d4-0000-4000-8000-000000000002\n`,
    )
    expect(code).toBe(0)
  })

  test("--first keeps only the top hit, so it composes with --url into a single openable url", async () => {
    const second = { ...PAYLOAD_ROW, id: "a1b2c3d4-0000-4000-8000-000000000002" }

    await searchCommand(
      { url: true, first: true },
      deps(stubFetch([], [listing([PAYLOAD_ROW, second], 2)])),
    )

    expect(out).toBe(`${webBase}/sessions/a1b2c3d4-0000-4000-8000-000000000001\n`)
  })

  test("--json prints the rows and the total as parseable json, with the url already resolved", async () => {
    await searchCommand({ json: true }, deps(stubFetch([], [listing([PAYLOAD_ROW], 7)])))

    expect(JSON.parse(out)).toEqual({
      total: 7,
      searchUrl: `${webBase}/sessions`,
      sessions: [
        { ...PAYLOAD_ROW, url: `${webBase}/sessions/a1b2c3d4-0000-4000-8000-000000000001` },
      ],
    })
  })

  test("--open with nothing to open says so rather than opening the empty search page", async () => {
    const code = await searchCommand({ open: true }, deps(stubFetch([], [listing([], 0)])))

    expect(err).toContain("nothing to open")
    expect(code).toBe(1)
  })

  const probe = {
    status: 200,
    body: {
      sessions: [],
      pagination: { page: 1, limit: 1, total: 0, totalPages: 0 },
      filterOptions: {
        projects: [{ value: "11111111-1111-4111-8111-111111111111", label: "Samskara Web" }],
        authors: [],
        repositories: [
          {
            value: "22222222-2222-4222-8222-222222222222",
            label: "vertexcover-io/samskara",
            repoName: "samskara",
          },
        ],
        branches: [],
      },
    },
  }

  test("a repo named the human way is resolved to its id through the server's own filter options", async () => {
    const calls: string[] = []

    const code = await searchCommand(
      { repo: "vertexcover-io/samskara" },
      deps(stubFetch(calls, [probe, listing([PAYLOAD_ROW], 1)])),
    )

    expect(calls).toEqual([`${API}?limit=1`, `${API}?repo=22222222-2222-4222-8222-222222222222`])
    expect(code).toBe(0)
  })

  test("a name that fits nothing stops before the search runs and says what was on offer", async () => {
    const calls: string[] = []

    const code = await searchCommand({ project: "nope" }, deps(stubFetch(calls, [probe])))

    expect(calls).toEqual([`${API}?limit=1`])
    expect(err).toContain("Samskara Web")
    expect(code).toBe(1)
  })

  test("--here fills the filters from the current checkout, and a flag typed by hand still wins", async () => {
    vi.mocked(getProject).mockResolvedValue({
      name: "samskara",
      path: "/work/app",
      enabled: true,
      enabledAt: "2026-01-01T00:00:00.000Z",
      projectId: "11111111-1111-4111-8111-111111111111",
    })
    gitReturning({
      "rev-parse --path-format=absolute --git-common-dir": "/work/app/.git",
      "config --get remote.origin.url": "git@github.com:vertexcover-io/samskara.git",
      "rev-parse --abbrev-ref HEAD": "master",
    })
    const calls: string[] = []

    const code = await searchCommand(
      { here: true, branch: "release" },
      deps(stubFetch(calls, [probe, listing([PAYLOAD_ROW], 1)])),
    )

    expect(calls).toEqual([
      `${API}?limit=1`,
      `${API}?project=11111111-1111-4111-8111-111111111111&repo=22222222-2222-4222-8222-222222222222&branch=release`,
    ])
    expect(code).toBe(0)
  })

  test("a today range carries this machine's time zone, the way the browser sends its own", async () => {
    // TZ, not `Intl.DateTimeFormat()`: deriving the expectation from the same call the code makes
    // would assert nothing. Berlin is chosen because ICU reports it back under its own name.
    const originalTz = process.env.TZ
    process.env.TZ = "Europe/Berlin"
    const calls: string[] = []

    await searchCommand({ range: "today" }, deps(stubFetch(calls, [listing([PAYLOAD_ROW], 1)])))
    process.env.TZ = originalTz

    expect(calls).toEqual([`${API}?range=today&tz=Europe%2FBerlin`])
  })

  test("an explicit --tz beats the machine's own zone", async () => {
    const originalTz = process.env.TZ
    process.env.TZ = "Europe/Berlin"
    const calls: string[] = []

    await searchCommand(
      { range: "today", tz: "Asia/Tokyo" },
      deps(stubFetch(calls, [listing([PAYLOAD_ROW], 1)])),
    )
    process.env.TZ = originalTz

    expect(calls).toEqual([`${API}?range=today&tz=Asia%2FTokyo`])
  })

  const writeCache = (fetchedAt: number, filterOptions: unknown) =>
    atomicWriteJson(filterOptionsPath(), { apiBase, fetchedAt, filterOptions })

  test("cached filter options resolve a name without asking the server for them a second time", async () => {
    await writeCache(NOW.getTime() - 60_000, probe.body.filterOptions)
    const calls: string[] = []

    await searchCommand(
      { repo: "vertexcover-io/samskara" },
      deps(stubFetch(calls, [listing([PAYLOAD_ROW], 1)])),
    )

    expect(calls).toEqual([`${API}?repo=22222222-2222-4222-8222-222222222222`])
  })

  test("a name the cache never heard of refetches before refusing, so a new repo is not invisible", async () => {
    await writeCache(NOW.getTime(), {
      projects: [],
      authors: [],
      repositories: [],
      branches: [],
    })
    const calls: string[] = []

    const code = await searchCommand(
      { repo: "vertexcover-io/samskara" },
      deps(stubFetch(calls, [probe, listing([PAYLOAD_ROW], 1)])),
    )

    expect(calls).toEqual([`${API}?limit=1`, `${API}?repo=22222222-2222-4222-8222-222222222222`])
    expect(code).toBe(0)
  })

  test("options older than the window are ignored, and what replaces them is written back", async () => {
    await writeCache(NOW.getTime() - 6 * 60_000, probe.body.filterOptions)
    const calls: string[] = []

    await searchCommand(
      { repo: "vertexcover-io/samskara" },
      deps(stubFetch(calls, [probe, listing([PAYLOAD_ROW], 1, probe.body.filterOptions)])),
    )

    expect(calls[0]).toBe(`${API}?limit=1`)
    expect(await readJson(filterOptionsPath())).toEqual({
      apiBase,
      fetchedAt: NOW.getTime(),
      filterOptions: probe.body.filterOptions,
    })
  })

  test("an ordinary search leaves the names behind, so the next search by name needs no probe", async () => {
    const calls: string[] = []
    const fetch = stubFetch(calls, [listing([PAYLOAD_ROW], 1, probe.body.filterOptions)])

    // No name filters, so this search resolves nothing -- it just carries the list home.
    await searchCommand({ query: "auth" }, deps(fetch))
    expect(calls).toHaveLength(1)

    await searchCommand({ repo: "vertexcover-io/samskara" }, deps(fetch))

    expect(calls[1]).toBe(`${API}?repo=22222222-2222-4222-8222-222222222222`)
  })

  test("a cache that cannot be written does not lose a search the server already answered", async () => {
    // A directory where the cache file belongs: the write fails, the search must not.
    await mkdir(filterOptionsPath())

    const code = await searchCommand(
      { repo: "vertexcover-io/samskara" },
      deps(stubFetch([], [probe, listing([PAYLOAD_ROW], 1)])),
    )

    expect(out).toContain("Fixing the auth redirect loop")
    expect(code).toBe(0)
  })
})

describe("hereFilters", () => {
  const REGISTERED = {
    name: "samskara",
    path: "/work/app",
    enabled: true,
    enabledAt: "2026-01-01T00:00:00.000Z",
    projectId: "11111111-1111-4111-8111-111111111111",
  }

  // A real directory: `--here` reads the checkout it is standing in, and a folder that is not
  // there has no identity at all. Everything else about the identity comes from the git mock.
  let here: string

  beforeEach(async () => {
    vi.mocked(getProject).mockResolvedValue(REGISTERED)
    here = await mkdtemp(join(tmpdir(), "samskara-here-"))
  })

  test("takes the project id from the registry and the repo and branch from the checkout", async () => {
    gitReturning({
      "rev-parse --path-format=absolute --git-common-dir": "/work/app/.git",
      "config --get remote.origin.url": "git@github.com:vertexcover-io/samskara.git",
      "rev-parse --abbrev-ref HEAD": "feat/thing",
    })

    expect(await hereFilters(here)).toEqual({
      project: "11111111-1111-4111-8111-111111111111",
      repo: "vertexcover-io/samskara",
      branch: "feat/thing",
    })
  })

  test("a detached HEAD contributes no branch, because HEAD is not the name of one", async () => {
    gitReturning({
      "rev-parse --path-format=absolute --git-common-dir": "/work/app/.git",
      "config --get remote.origin.url": "git@github.com:vertexcover-io/samskara.git",
      "rev-parse --abbrev-ref HEAD": "HEAD",
    })

    expect(await hereFilters(here)).toEqual({
      project: "11111111-1111-4111-8111-111111111111",
      repo: "vertexcover-io/samskara",
    })
  })

  test("a folder that is not there contributes nothing rather than filtering on an invented slug", async () => {
    gitReturning({ "config --get remote.origin.url": "git@github.com:vertexcover-io/samskara.git" })

    expect(await hereFilters(join(here, "gone"))).toEqual({})
  })

  test("a folder that is neither registered nor a remote-backed repo contributes nothing", async () => {
    vi.mocked(getProject).mockResolvedValue(null)
    gitReturning({})

    expect(await hereFilters(here)).toEqual({})
  })
})
