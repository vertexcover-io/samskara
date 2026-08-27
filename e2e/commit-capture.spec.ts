import { type ChildProcess, execFile, spawn } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { SignJWT } from "jose"
import postgres from "postgres"
import { requireDatabaseUrl } from "./db.js"
import { expect, test } from "./fixtures/auth.js"
import { API_BASE } from "./playwright.config.js"
import { E2E_USER_ID, seedDatabase } from "./seed.js"
import {
  assistantLine,
  createTranscriptWriter,
  toolCallLine,
  toolResultLine,
  userLine,
} from "./transcript.js"

const JWT_SECRET = process.env.JWT_SECRET ?? "e2e-secret"
const DATABASE_URL = requireDatabaseUrl()
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url))
const CLI_ENTRY = join(REPO_ROOT, "packages/cli/src/index.ts")

const PIPELINE_TIMEOUT_MS = 45_000
const POLL_INTERVAL_MS = 250

const SESSION_ID = "5c1f7a30-9b2e-4d61-a8c4-3e7f0b6d2a91"
const PROJECT_SLUG = "acme-widgets"
const PROJECT_NAME = "acme-widgets"
const GIT_REMOTE = "git@github.com:acme/widgets.git"
/** The sub-repo the commit is made in -- a different remote, so a different `repos` row. */
const SUB_REPO_NAME = "serana"
const SUB_REPO_REMOTE = "git@github.com:refrens/serana.git"
const SUB_REPO_SLUG = "refrens-serana"

const execFileAsync = promisify(execFile)

/**
 * Claude stamps `cwd` on every transcript line, so a session that moves between checkouts writes
 * both cwds into one file. The shared writer pins one cwd, so the moved-to lines are appended
 * here directly.
 */
const appendWithCwd = (
  path: string,
  cwd: string,
  lines: ReadonlyArray<Record<string, unknown>>,
): Promise<void> =>
  writeFile(
    path,
    lines.map((line) => `${JSON.stringify({ ...line, sessionId: SESSION_ID, cwd })}\n`).join(""),
    { flag: "a", encoding: "utf8" },
  )

type Sql = ReturnType<typeof postgres>

const mintCliToken = (): Promise<string> =>
  new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("samskara")
    .setAudience("cli")
    .setSubject(E2E_USER_ID)
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(JWT_SECRET))

const pollUntil = async <T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  describe: (value: T) => string,
  timeoutMs = PIPELINE_TIMEOUT_MS,
): Promise<T> => {
  const deadline = Date.now() + timeoutMs
  let last: T = await read()
  while (!done(last)) {
    if (Date.now() > deadline) {
      throw new Error(
        `timed out after ${timeoutMs}ms waiting for pipeline; last saw ${describe(last)}`,
      )
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
    last = await read()
  }
  return last
}

type Harness = {
  readonly home: string
  readonly cwd: string
  readonly subRepo: string
  readonly sql: Sql
  readonly logs: ReadonlyArray<string>
  readonly writer: ReturnType<typeof createTranscriptWriter>
  stop(): Promise<void>
}

/**
 * Boots the real watcher against a throwaway HOME containing two real git checkouts: the
 * project root and a sub-repo nested inside it with its own remote. The commit is made in the
 * sub-repo, which is the case that forces repo attribution to come from the message's own cwd.
 */
const startHarness = async (): Promise<Harness> => {
  const home = await mkdtemp(join(tmpdir(), "samskara-commit-e2e-"))
  const samskaraHome = join(home, ".samskara")
  const cwd = join(home, "work", PROJECT_NAME)
  const subRepo = join(cwd, ".workspaces", SUB_REPO_NAME)
  await mkdir(subRepo, { recursive: true })
  await mkdir(samskaraHome, { recursive: true })

  await execFileAsync("git", ["init", "-q"], { cwd })
  await execFileAsync("git", ["remote", "add", "origin", GIT_REMOTE], { cwd })
  await execFileAsync("git", ["init", "-q"], { cwd: subRepo })
  await execFileAsync("git", ["remote", "add", "origin", SUB_REPO_REMOTE], { cwd: subRepo })

  await writeFile(join(samskaraHome, "token"), await mintCliToken(), "utf8")
  await writeFile(
    join(samskaraHome, "projects.json"),
    JSON.stringify({
      version: 1,
      projects: {
        [PROJECT_SLUG]: {
          name: PROJECT_NAME,
          path: cwd,
          enabled: true,
          enabledAt: new Date(Date.UTC(2026, 5, 1, 11)).toISOString(),
        },
        // The session runs in the sub-repo, so the sub-repo is the project that owns it. Both are
        // enabled: which one captures the session is decided by the transcript's cwd, and commits
        // are attributed per message on top of that.
        [SUB_REPO_SLUG]: {
          name: SUB_REPO_NAME,
          path: subRepo,
          enabled: true,
          enabledAt: new Date(Date.UTC(2026, 5, 1, 11)).toISOString(),
        },
      },
    }),
    "utf8",
  )

  const probe = await fetch(`${API_BASE}/api/ingest`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${await mintCliToken()}`,
    },
    body: JSON.stringify({}),
  })
  if (probe.status === 401) {
    throw new Error(
      `the API at ${API_BASE} rejected an e2e CLI token (401) -- it is signing with a different JWT_SECRET than this spec mints with.`,
    )
  }

  const child: ChildProcess = spawn(
    "bun",
    // No project override: the daemon derives `acme-widgets` from this fixture's git remote,
    // which is the slug `projects.json` above marks enabled.
    [CLI_ENTRY, "watch", "--foreground"],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        HOME: home,
        SAMSKARA_HOME: samskaraHome,
        SAMSKARA_DAEMON: "1",
        SAMSKARA_API_URL: API_BASE,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  )
  const logs: string[] = []
  child.stdout?.on("data", (chunk: Buffer) => logs.push(chunk.toString()))
  child.stderr?.on("data", (chunk: Buffer) => logs.push(chunk.toString()))

  const sql = postgres(DATABASE_URL)

  return {
    home,
    cwd,
    subRepo,
    sql,
    logs,
    // The transcript's cwd is the SUB-REPO, so every message resolves to `serana`.
    writer: createTranscriptWriter({ home, cwd: subRepo, sessionId: SESSION_ID }),
    stop: async () => {
      child.kill("SIGTERM")
      await sql.end()
      await rm(home, { recursive: true, force: true })
    },
  }
}

let harness: Harness

const harnessTeardown = async (): Promise<void> => {
  if (harness) await harness.stop()
}

test.beforeEach(async () => {
  // Stop the daemon first: it holds a connection and writes rows while the seed truncates.
  await harnessTeardown()
  await seedDatabase({ projects: [] })
})

test.afterEach(harnessTeardown)

test.describe("commit capture", () => {
  test.describe.configure({ timeout: 90_000 })

  test("E1: a git commit run in a session lands as a commit row keyed to the repo of the cwd it ran in, and re-ingesting it changes nothing", async () => {
    harness = await startHarness()
    const { writer, sql } = harness

    // Real `git commit` output, verbatim in shape: hook noise first, then the [branch sha]
    // line, then the stat line and trailing `create mode` lines.
    const commitOutput = [
      'npm warn Unknown project config "scripts-prepend-node-path".',
      "ℹ No staged files match any configured task.",
      "[feat/local-source-graph 2314a2e44] feat: collapse deep imports",
      " 3 files changed, 8 insertions(+), 2 deletions(-)",
      " create mode 100644 src/graph.ts",
    ].join("\n")

    await writer.append([
      userLine("Commit the import collapse.", 0),
      assistantLine("Committing now.", 1),
      toolCallLine(
        "toolu-commit-1",
        "Bash",
        { command: "git commit -m 'feat: collapse deep imports'" },
        2,
      ),
      toolResultLine("toolu-commit-1", commitOutput, 3),
    ])

    const rows = await pollUntil(
      () => sql<{ sha: string; branch: string | null; repoName: string }[]>`
        select c.sha, c.branch, r."repoName" as "repoName"
        from commits c join repos r on r.id = c."repoId"
        where c."sessionId" = ${SESSION_ID}
      `,
      (r) => r.length >= 1,
      (r) => `${r.length} commit rows; daemon said: ${harness.logs.join("")}`,
    )

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      sha: "2314a2e44",
      branch: "feat/local-source-graph",
      repoName: SUB_REPO_NAME,
    })

    const [full] = await sql<
      {
        subject: string | null
        filesChanged: number | null
        insertions: number | null
        deletions: number | null
        messageId: string | null
      }[]
    >`
      select subject, "filesChanged", insertions, deletions, "messageId"
      from commits where "sessionId" = ${SESSION_ID}
    `
    expect(full).toMatchObject({
      subject: "feat: collapse deep imports",
      filesChanged: 3,
      insertions: 8,
      deletions: 2,
    })

    const [caller] = await sql<{ id: string; msgType: string }[]>`
      select id, "msgType" from messages
      where "sessionId" = ${SESSION_ID} and "msgType" = 'toolCall'
    `
    expect(full?.messageId).toBe(caller?.id)

    const attributed = await sql<{ count: string }[]>`
      select count(*)::text as count from commits c
      join repos r on r.id = c."repoId"
      where c."sessionId" = ${SESSION_ID} and r."repoName" = 'widgets'
    `
    expect(Number(attributed[0]?.count)).toBe(0)

    // Appending more lines makes the watcher re-flush the track; the commit must stay singular.
    await writer.append([assistantLine("Committed.", 4)])
    await pollUntil(
      () => sql<{ count: string }[]>`
        select count(*)::text as count from messages where "sessionId" = ${SESSION_ID}
      `,
      (r) => Number(r[0]?.count ?? 0) >= 5,
      (r) => `${r[0]?.count ?? 0} message rows`,
    )

    const after = await sql<{ count: string }[]>`
      select count(*)::text as count from commits where "sessionId" = ${SESSION_ID}
    `
    expect(Number(after[0]?.count)).toBe(1)
  })

  test("E2/S20: one session opening a PR and committing in two checkouts records the PR against the repo its url named, and each commit against the checkout it ran in", async () => {
    harness = await startHarness()
    const { writer, sql, cwd } = harness

    await writer.append([
      userLine("Open the PR, then commit in both checkouts.", 0),
      assistantLine("Opening the PR.", 1),
      toolCallLine("toolu-pr-1", "Bash", { command: "gh pr create --fill" }, 2),
      // The PR names `refrens/birds` -- a repo no cwd in this session ever pointed at, which is
      // exactly why a PR's repo must come from its url rather than the call's working directory.
      toolResultLine("toolu-pr-1", "https://github.com/refrens/birds/pull/391", 3),
      // A PR merely viewed is not recorded -- the single row asserted below proves this pair
      // contributed nothing.
      toolCallLine("toolu-pr-2", "Bash", { command: "gh pr view 391" }, 4),
      toolResultLine("toolu-pr-2", "https://github.com/refrens/birds/pull/391", 5),
      toolCallLine("toolu-commit-sub", "Bash", { command: "git commit -m 'feat: sub'" }, 6),
      toolResultLine(
        "toolu-commit-sub",
        "[main 5ab1111] feat: sub\n 1 file changed, 2 insertions(+)",
        7,
      ),
    ])

    // The second commit is made in the PROJECT ROOT checkout. Claude writes cwd per line, so the
    // move shows up as a different cwd on the same transcript -- which is what makes one session
    // span two repos.
    await appendWithCwd(writer.mainPath, cwd, [
      toolCallLine("toolu-commit-root", "Bash", { command: "git commit -m 'feat: root'" }, 8),
      toolResultLine(
        "toolu-commit-root",
        "[main c00d222] feat: root\n 4 files changed, 9 insertions(+)",
        9,
      ),
    ])

    const commitRows = await pollUntil(
      () => sql<{ sha: string; repoName: string }[]>`
        select c.sha, r."repoName" as "repoName"
        from commits c join repos r on r.id = c."repoId"
        where c."sessionId" = ${SESSION_ID} order by c.sha
      `,
      (rows) => rows.length >= 2,
      (rows) => `${rows.length} commit rows; daemon said: ${harness.logs.join("")}`,
    )

    expect(commitRows).toEqual([
      { sha: "5ab1111", repoName: SUB_REPO_NAME },
      { sha: "c00d222", repoName: "widgets" },
    ])

    const prRows = await pollUntil(
      () => sql<{ number: number; repoName: string }[]>`
        select p.number, r."repoName" as "repoName"
        from "sessionPullRequests" spr
        join "pullRequests" p on p.id = spr."prId"
        join repos r on r.id = p."repoId"
        where spr."sessionId" = ${SESSION_ID}
      `,
      (rows) => rows.length >= 1,
      (rows) => `${rows.length} pull request rows; daemon said: ${harness.logs.join("")}`,
    )

    expect(prRows).toEqual([{ number: 391, repoName: "birds" }])
  })
})
