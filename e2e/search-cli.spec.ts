import { execFile, execFileSync } from "node:child_process"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { expect, mintCliToken, test } from "./fixtures/auth.js"
import { API_BASE, WEB_BASE } from "./playwright.config.js"
import { projectId, seedDatabase } from "./seed.js"

// Functional-verify evidence for `samskara search` (design: .harness/samskara-search-cli/design.md).
// This is a headless feature -- its whole surface is CLI stdout/stderr/exit code plus the two
// HTTP routes it touches -- so every scenario here drives the real CLI binary against the
// live stack `bun run e2e` provisions, and logs the verbatim exchange for the proof report.

const execFileAsync = promisify(execFile)
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const CLI_ENTRY = join(REPO_ROOT, "packages/cli/src/index.ts")
// Playwright's test workers run under Node, so `process.execPath` here is node, not bun -- and
// one scenario below deliberately breaks PATH to prove the CLI's own child-process spawn fails
// gracefully. Resolving bun's absolute path once, up front, means that scenario can still find
// bun even after it removes PATH for the CLI's own subprocess lookup.
const BUN_BIN = execFileSync("which", ["bun"], { encoding: "utf8" }).trim()

const REPOSITORY = "repo-acme"

const decoyProject = (slug: string, name: string) => ({
  slug,
  name,
  sessions: [{ id: `verify-decoy-${slug}`, title: `${name} placeholder session` }],
})

const SEED = {
  repositories: [{ key: REPOSITORY, host: "github.com", owner: "acme", repoName: "samskara" }],
  projects: [
    {
      slug: "samskara",
      name: "Samskara",
      sessions: [
        {
          id: "verify-free-hit",
          title: "Fixing the redirect loop in the auth guard",
          messages: [
            {
              msgType: "message",
              content: { text: "the redirect glitch reproduces every time" },
              repository: REPOSITORY,
              gitBranch: "master",
            },
          ],
        },
        { id: "verify-free-miss", title: "Unrelated ledger notes" },
        {
          id: "verify-out-a",
          title: "Alpha output demo",
          messages: [{ msgType: "message", repository: REPOSITORY, gitBranch: "output-demo" }],
        },
        {
          id: "verify-out-b",
          title: "Beta output demo",
          messages: [{ msgType: "message", repository: REPOSITORY, gitBranch: "output-demo" }],
        },
        {
          id: "verify-commit-a",
          title: "Commit target A",
          commits: [{ repository: REPOSITORY, sha: "abcdef1111111111111111111111111111" }],
        },
        {
          id: "verify-commit-b",
          title: "Commit target B",
          commits: [{ repository: REPOSITORY, sha: "abcdef1222222222222222222222222222" }],
        },
        {
          id: "verify-multi-hit",
          title: "Multi filter target",
          author: "other" as const,
          pullRequests: [{ repository: REPOSITORY, number: 501, title: "Multi filter target PR" }],
        },
        {
          id: "verify-multi-decoy",
          title: "Multi filter decoy",
          pullRequests: [{ repository: REPOSITORY, number: 502, title: "Multi filter decoy PR" }],
        },
        {
          id: "verify-here-hit",
          title: "Here filter target",
          messages: [{ msgType: "message", repository: REPOSITORY, gitBranch: "here-demo-branch" }],
        },
      ],
    },
    decoyProject("alpha-suite", "Alpha Suite"),
    decoyProject("analytics-hub", "Analytics Hub"),
    decoyProject("auth-gateway", "Auth Gateway"),
    decoyProject("auth-ops", "Auth Ops"),
    decoyProject("billing-core", "Billing Core"),
    decoyProject("compliance-pack", "Compliance Pack"),
    decoyProject("design-kit", "Design Kit"),
    decoyProject("growth-bot", "Growth Bot"),
    decoyProject("infra-tools", "Infra Tools"),
    decoyProject("ledger-app", "Ledger App"),
    decoyProject("metrics-pipe", "Metrics Pipe"),
    decoyProject("zephyr-search-ops", "Zephyr Search Ops"),
    {
      slug: "other-project",
      name: "Maya Private Project",
      owner: "other" as const,
      sessions: [{ id: "verify-other-hidden", title: "Hidden from primary" }],
    },
  ],
}

let home: string

const runCli = async (
  args: ReadonlyArray<string>,
  opts: { readonly cwd?: string; readonly env?: Record<string, string | undefined> } = {},
): Promise<{ code: number; stdout: string; stderr: string }> => {
  const env = {
    ...process.env,
    SAMSKARA_HOME: home,
    SAMSKARA_API_URL: API_BASE,
    SAMSKARA_WEB_URL: WEB_BASE,
    ...opts.env,
  }
  const command = `bun ${CLI_ENTRY} search ${args.join(" ")}`
  const cwd = opts.cwd ?? REPO_ROOT
  try {
    const { stdout, stderr } = await execFileAsync(BUN_BIN, [CLI_ENTRY, "search", ...args], {
      cwd,
      env,
    })
    console.log(`$ ${command}\n→ exit 0\nstdout:\n${stdout}${stderr ? `stderr:\n${stderr}\n` : ""}`)
    return { code: 0, stdout, stderr }
  } catch (error) {
    const err = error as { code?: number; stdout?: string; stderr?: string }
    console.log(
      `$ ${command}\n→ exit ${err.code ?? 1}\nstdout:\n${err.stdout ?? ""}stderr:\n${err.stderr ?? ""}\n`,
    )
    return { code: err.code ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" }
  }
}

test.beforeEach(async () => {
  await seedDatabase(SEED)
  home = await mkdtemp(join(tmpdir(), "samskara-search-verify-"))
  await writeFile(join(home, "token"), await mintCliToken(), "utf8")
})

test("01: a free-text search prints the matching session and omits a default range from the echoed search url", async () => {
  const { stdout } = await runCli(["redirect", "--range", "all"])

  expect(stdout).toContain("Fixing the redirect loop in the auth guard")
  expect(stdout).not.toContain("Unrelated ledger notes")
  expect(stdout).toContain("1 of 1")
  expect(stdout).toContain(`${WEB_BASE}/sessions?q=redirect`)
  expect(stdout).not.toContain("range=")
})

test("02: --repo resolves an owner/name label", async () => {
  const exact = await runCli(["--repo", "acme/samskara", "--branch", "master", "--url"])
  expect(exact.stdout).toBe(`${WEB_BASE}/sessions/verify-free-hit\n`)
})

test("04: each filter the server rejects comes back naming the offending flag", async () => {
  const cases: ReadonlyArray<[ReadonlyArray<string>, string]> = [
    [["--pr", "abc"], "--pr takes a pull request number"],
    [["--commit", "zz"], "--commit takes 7 to 40 hex"],
    [["--range", "whenever"], "--range takes all, hour, today, week, month or custom"],
    [["--sort", "random"], "--sort takes relevance, recent, oldest or project"],
    // tz only reaches the server for today/custom (design's serialization rule) -- unadorned it
    // would never be sent, so the range is part of what this case is proving.
    [["--range", "today", "--tz", "Nowhere/Fake"], "--tz takes an IANA time zone"],
    [["a".repeat(201)], "not a query this server accepts"],
  ]
  for (const [args, expected] of cases) {
    const { code, stderr } = await runCli(args)
    expect(code).toBe(1)
    expect(stderr).toContain(expected)
  }
})

test("10: --here fills project, repo and branch from the checkout, and an explicit flag overrides it", async () => {
  const repoDir = await mkdtemp(join(tmpdir(), "samskara-here-"))
  await execFileAsync("git", ["init", "-q", "-b", "here-demo-branch"], { cwd: repoDir })
  await execFileAsync("git", ["config", "user.email", "e2e@example.com"], { cwd: repoDir })
  await execFileAsync("git", ["config", "user.name", "E2E"], { cwd: repoDir })
  await writeFile(join(repoDir, "README.md"), "x")
  await execFileAsync("git", ["add", "."], { cwd: repoDir })
  await execFileAsync("git", ["commit", "-q", "-m", "init"], { cwd: repoDir })
  await execFileAsync("git", ["remote", "add", "origin", "https://github.com/acme/samskara.git"], {
    cwd: repoDir,
  })
  await writeFile(
    join(home, "projects.json"),
    JSON.stringify(
      {
        version: 1,
        projects: {
          "acme-samskara": {
            name: "Samskara",
            path: repoDir,
            enabled: true,
            enabledAt: new Date().toISOString(),
            projectId: projectId("samskara"),
          },
        },
      },
      null,
      2,
    ),
    "utf8",
  )

  const here = await runCli(["--here", "--url"], { cwd: repoDir })
  expect(here.stdout).toBe(`${WEB_BASE}/sessions/verify-here-hit\n`)

  const overridden = await runCli(["--here", "--branch", "output-demo", "--url"], { cwd: repoDir })
  const lines = overridden.stdout.trim().split("\n").sort()
  expect(lines).toEqual(
    [`${WEB_BASE}/sessions/verify-out-a`, `${WEB_BASE}/sessions/verify-out-b`].sort(),
  )
})

test("11: a browser that cannot be opened still hands back the session url instead of throwing", async () => {
  const { code, stderr, stdout } = await runCli(
    ["--repo", "acme/samskara", "--branch", "master", "--open"],
    { env: { PATH: "/nonexistent-samskara-verify-path" } },
  )
  expect(code).toBe(1)
  expect(stdout).toBe("")
  expect(stderr).toContain("Could not open a browser")
  expect(stderr).toContain(`${WEB_BASE}/sessions/verify-free-hit`)
})

test("11b: --open hands the session url to the platform opener and reports what it opened", async () => {
  // A fake `open`/`xdg-open` first on PATH: the success branch of the spawn is otherwise untested
  // at every level, since scenario 11 only proves the failure branch.
  const binDir = await mkdtemp(join(tmpdir(), "samskara-fake-opener-"))
  const opened = join(binDir, "opened.txt")
  const name = process.platform === "darwin" ? "open" : "xdg-open"
  await writeFile(join(binDir, name), `#!/bin/sh\nprintf '%s' "$1" > ${opened}\n`, {
    mode: 0o755,
  })

  const { code, stdout, stderr } = await runCli(
    ["--repo", "acme/samskara", "--branch", "master", "--open"],
    { env: { PATH: `${binDir}:${process.env.PATH ?? ""}` } },
  )

  expect(stderr).not.toContain("Could not open a browser")
  expect(code).toBe(0)
  expect(stdout.trim()).toBe(`${WEB_BASE}/sessions/verify-free-hit`)
  // The opener really ran, and really received the session url.
  expect(await readFile(opened, "utf8")).toBe(`${WEB_BASE}/sessions/verify-free-hit`)
})

test("12: resolving a name by search writes the filter-options cache to disk at owner-only permissions", async () => {
  await runCli(["--repo", "samskara"])

  const path = join(home, "filter-options.json")
  const content = await readFile(path, "utf8")
  const parsed = JSON.parse(content)
  expect(parsed.apiBase).toBe(API_BASE)
  expect(typeof parsed.fetchedAt).toBe("number")
  expect(Array.isArray(parsed.filterOptions.projects)).toBe(true)

  const { stat } = await import("node:fs/promises")
  const mode = (await stat(path)).mode & 0o777
  expect(mode).toBe(0o600)
})

test("15: a custom range with an explicit tz windows to the calendar day, excluding every other seeded day", async () => {
  const { stdout } = await runCli([
    "--range",
    "custom",
    "--from",
    "2026-02-01",
    "--to",
    "2026-02-01",
    "--tz",
    "UTC",
    "--json",
  ])
  const parsed = JSON.parse(stdout)
  expect(parsed.total).toBe(9)
  const titles = parsed.sessions.map((s: { title: string }) => s.title)
  expect(titles).toContain("Here filter target")
  expect(titles).not.toContain("Zephyr Search Ops placeholder session")
})
