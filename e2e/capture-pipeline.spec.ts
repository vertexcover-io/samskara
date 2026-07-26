import { type ChildProcess, execFile, spawn } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { SignJWT } from "jose"
import postgres from "postgres"
import { expect, test } from "./fixtures/auth.js"
import { API_BASE } from "./playwright.config.js"
import { E2E_USER_ID, seedDatabase } from "./seed.js"
import {
  assistantLine,
  createTranscriptWriter,
  summaryLine,
  toolCallLine,
  toolResultLine,
  userLine,
} from "./transcript.js"

const JWT_SECRET = process.env.JWT_SECRET ?? "e2e-secret"
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://samskara:samskara@localhost:5433/samskara"
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url))
const CLI_ENTRY = join(REPO_ROOT, "packages/cli/src/index.ts")

// The watcher polls every 10s, so a full cycle plus ingest has to fit inside this.
const PIPELINE_TIMEOUT_MS = 45_000
const POLL_INTERVAL_MS = 250

const SESSION_ID = "0b9d4c1e-7f3a-4c22-9a6e-1d5f8b2c3e40"
const PROJECT_SLUG = "acme-widgets"
const PROJECT_NAME = "acme-widgets"
// `resolveProject` turns this remote into the slug `acme-widgets`, matching PROJECT_SLUG.
const GIT_REMOTE = "git@github.com:acme/widgets.git"

const execFileAsync = promisify(execFile)

type Sql = ReturnType<typeof postgres>

const mintCliToken = (): Promise<string> =>
  new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("samskara")
    .setAudience("cli")
    .setSubject(E2E_USER_ID)
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(JWT_SECRET))

/**
 * Polls until `read` returns a value satisfying `done`, or the deadline passes.
 * Nothing in this spec sleeps for a fixed duration: the watcher's cycle boundary is
 * not observable from here, so a fixed sleep would be either flaky or needlessly slow.
 */
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
  readonly samskaraHome: string
  readonly cwd: string
  readonly sql: Sql
  readonly writer: ReturnType<typeof createTranscriptWriter>
  stop(): Promise<void>
}

type HarnessOptions = {
  /**
   * `--project-slug` makes the watcher capture unconditionally and stub out project
   * resolution. Tests that care about enablement must leave it off, so the daemon runs
   * its real `isProjectEnabled` check and resolves the slug from the git remote.
   */
  readonly projectOverride?: boolean
  /** What `projects.json` records for this project; omit the entry entirely with `null`. */
  readonly enabled?: boolean | null
}

/**
 * Boots the real `samskara watch --foreground` daemon against a throwaway HOME.
 * `~/.claude/projects` and `~/.samskara` both live inside it, so the watcher's real
 * glob and its real state file are exercised — no test seam substitutes for either.
 */
const startHarness = async (options: HarnessOptions = {}): Promise<Harness> => {
  const { projectOverride = true, enabled = true } = options
  const home = await mkdtemp(join(tmpdir(), "samskara-e2e-"))
  const samskaraHome = join(home, ".samskara")
  const cwd = join(home, "work", PROJECT_NAME)
  await mkdir(cwd, { recursive: true })
  await mkdir(samskaraHome, { recursive: true })

  // A real git remote, so that without --project-slug the daemon's own resolver derives
  // `acme-widgets` from it. Without this the slug would be the machine-specific path.
  await execFileAsync("git", ["init", "-q"], { cwd })
  await execFileAsync("git", ["remote", "add", "origin", GIT_REMOTE], { cwd })

  // The watcher only captures projects marked enabled, and reads its token from disk —
  // both are the real files `samskara login` and `samskara enable` would have written.
  await writeFile(join(samskaraHome, "token"), await mintCliToken(), "utf8")
  await writeFile(
    join(samskaraHome, "projects.json"),
    JSON.stringify({
      version: 1,
      projects:
        enabled === null
          ? {}
          : {
              [PROJECT_SLUG]: {
                name: PROJECT_NAME,
                path: cwd,
                enabled,
                enabledAt: new Date(Date.UTC(2026, 5, 1, 11)).toISOString(),
              },
            },
    }),
    "utf8",
  )

  // Fail loudly here rather than as a silent 45s ingest timeout: an auth mismatch
  // between the token and the server makes every upload 401, which otherwise looks
  // like a broken pipeline rather than a broken fixture.
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
    [
      CLI_ENTRY,
      "watch",
      "--foreground",
      ...(projectOverride ? ["--project-name", PROJECT_NAME, "--project-slug", PROJECT_SLUG] : []),
    ],
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
  child.on("exit", (code) => {
    if (code !== 0 && code !== null) {
      logs.push(`watcher exited with code ${code}`)
    }
  })

  const sql = postgres(DATABASE_URL)

  return {
    home,
    samskaraHome,
    cwd,
    sql,
    writer: createTranscriptWriter({ home, cwd, sessionId: SESSION_ID }),
    stop: async () => {
      child.kill("SIGTERM")
      await sql.end()
      await rm(home, { recursive: true, force: true })
    },
  }
}

let harness: Harness

/**
 * `seedDatabase` only removes projects it seeded, but this spec's project and session are
 * created by the pipeline itself. Without this the next test polls against the previous
 * test's rows, is satisfied instantly, and passes without observing any new output.
 */
const clearPipelineRows = async (): Promise<void> => {
  const sql = postgres(DATABASE_URL)
  try {
    await sql`delete from sessions where id = ${SESSION_ID}`
    await sql`delete from projects where slug = ${PROJECT_SLUG}`
  } finally {
    await sql.end()
  }
}

/** Starts the daemon for one test; the afterEach hook tears it down. */
const useHarness = async (options: HarnessOptions = {}): Promise<Harness> => {
  harness = await startHarness(options)
  return harness
}

type CheckpointStore = {
  checkpoints: Record<string, { projectSlug?: string; lineProcessed?: number }>
}

/** Reads the daemon's real state file, or null before its first cycle completes. */
const readState = async (samskaraHome: string): Promise<CheckpointStore | null> => {
  try {
    return JSON.parse(await readFile(join(samskaraHome, "state.json"), "utf8")) as CheckpointStore
  } catch {
    return null
  }
}

/** Resolves once the daemon has completed at least one full cycle. */
const awaitCycle = (samskaraHome: string): Promise<CheckpointStore | null> =>
  pollUntil(
    () => readState(samskaraHome),
    (state) => state !== null,
    () => "no state.json yet -- the daemon never completed a cycle",
  )

test.beforeEach(async () => {
  // Clears prior e2e rows and (re)creates the E2E user the CLI token is subject to.
  await seedDatabase({ projects: [] })
  await harnessTeardown()
  await clearPipelineRows()
})

const harnessTeardown = async (): Promise<void> => {
  if (harness) await harness.stop()
}

test.afterEach(harnessTeardown)

test.describe("capture pipeline", () => {
  test.describe.configure({ timeout: 90_000 })

  test("P1: a transcript appearing on disk flows through the real watcher into Postgres, and the CLI's own state file records the project it synced", async () => {
    const { writer, sql, samskaraHome } = await useHarness()

    await writer.append([
      userLine("Rescans duplicate rows - make ingest idempotent.", 0),
      assistantLine("Plan: add a unique key, then switch inserts to upserts.", 1),
      toolCallLine("tool-grep-1", "Grep", { pattern: "INSERT INTO sessions" }, 2),
      toolResultLine("tool-grep-1", "src/ingest.ts:142", 3),
      summaryLine("Made ingest idempotent", 4),
    ])

    const rows = await pollUntil(
      () => sql<{ msgType: string }[]>`
        select "msgType" from messages where "sessionId" = ${SESSION_ID} order by "lineNumber"
      `,
      (r) => r.length >= 5,
      (r) =>
        `${r.length} message rows [${[...new Set(r.map((m) => m.msgType))].sort().join(", ")}]`,
    )

    // The message-type set is the load-bearing assertion: it proves the normalizer ran
    // over real transcript shapes, not that some rows merely arrived.
    expect(new Set(rows.map((r) => r.msgType))).toEqual(
      new Set(["message", "toolCall", "toolResult", "systemEvent"]),
    )

    const [session] = await sql<{ projectId: string; userId: string; source: string }[]>`
      select "projectId", "userId", source from sessions where id = ${SESSION_ID}
    `
    if (!session) throw new Error(`no session row was created for ${SESSION_ID}`)
    expect(session.source).toBe("claude_code")
    expect(session.userId).toBe(E2E_USER_ID)

    // The project is created by the pipeline itself, from the cwd the transcript carries.
    const [project] = await sql<{ slug: string; name: string }[]>`
      select slug, name from projects where id = ${session.projectId}
    `
    expect(project?.slug).toBe(PROJECT_SLUG)

    // The regression that shipped: every checkpoint the watcher writes must carry the
    // projectSlug, or `samskara status` reports "synced never" despite a full upload.
    const state = await pollUntil(
      async () => {
        try {
          return JSON.parse(await readFile(join(samskaraHome, "state.json"), "utf8")) as {
            checkpoints: Record<string, { projectSlug?: string; lastUpdatedAt?: string }>
          }
        } catch {
          return { checkpoints: {} }
        }
      },
      (s) => Object.keys(s.checkpoints).length > 0,
      (s) => `${Object.keys(s.checkpoints).length} checkpoints`,
    )

    const checkpoints = Object.values(state.checkpoints)
    expect(checkpoints.length).toBeGreaterThan(0)
    for (const checkpoint of checkpoints) {
      expect(checkpoint.projectSlug).toBe(PROJECT_SLUG)
      expect(checkpoint.lastUpdatedAt).toBeTruthy()
    }
  })

  test("P2: lines appended to a live transcript are ingested incrementally without duplicating the lines already sent", async () => {
    const { writer, sql } = await useHarness()

    await writer.append([userLine("First turn.", 0), assistantLine("First answer.", 1)])

    const first = await pollUntil(
      () => sql<{ count: string }[]>`
        select count(*)::text as count from messages where "sessionId" = ${SESSION_ID}
      `,
      (r) => Number(r[0]?.count ?? 0) >= 2,
      (r) => `${r[0]?.count ?? 0} rows`,
    )
    expect(Number(first[0]?.count)).toBe(2)

    await writer.append([userLine("Second turn.", 2), assistantLine("Second answer.", 3)])

    const second = await pollUntil(
      () => sql<{ count: string }[]>`
        select count(*)::text as count from messages where "sessionId" = ${SESSION_ID}
      `,
      (r) => Number(r[0]?.count ?? 0) >= 4,
      (r) => `${r[0]?.count ?? 0} rows`,
    )
    // Exactly four: the checkpoint must have stopped the first two from being resent.
    expect(Number(second[0]?.count)).toBe(4)

    const lineNumbers = await sql<{ lineNumber: number }[]>`
      select distinct "lineNumber" from messages where "sessionId" = ${SESSION_ID} order by "lineNumber"
    `
    expect(lineNumbers.map((r) => r.lineNumber)).toEqual([1, 2, 3, 4])
  })

  test("P3: a subagent sidecar lands as a subagent track against the same session", async () => {
    const { writer, sql } = await useHarness()

    await writer.append([userLine("Audit the constraints.", 0), assistantLine("Delegating.", 1)])
    await pollUntil(
      () => sql<{ id: string }[]>`select id from sessions where id = ${SESSION_ID}`,
      (r) => r.length === 1,
      (r) => `${r.length} sessions`,
    )

    await writer.appendSubagent(
      "audit",
      [assistantLine("No unique constraints exist on the ingest tables.", 2)],
      { agentType: "db-schema-auditor", description: "Audit unique constraints" },
    )

    const subagents = await pollUntil(
      () => sql<{ agentId: string; agentType: string | null }[]>`
        select "agentId", "agentType" from subagents where "sessionId" = ${SESSION_ID}
      `,
      (r) => r.length >= 1,
      (r) => `${r.length} subagents`,
    )
    expect(subagents[0]?.agentId).toBe("audit")
    expect(subagents[0]?.agentType).toBe("db-schema-auditor")

    const flagged = await sql<{ count: string }[]>`
      select count(*)::text as count from messages
      where "sessionId" = ${SESSION_ID} and "isSubagent" = true
    `
    expect(Number(flagged[0]?.count)).toBeGreaterThan(0)
  })

  test("P4: a session captured by the watcher is readable in the web UI, listed under its project and opening to its conversation", async ({
    authedPage: page,
  }) => {
    const { writer, sql } = await useHarness()

    await writer.append([
      userLine("Rescans duplicate rows - make ingest idempotent.", 0),
      assistantLine("Plan: add a unique key, then switch inserts to upserts.", 1),
    ])

    await pollUntil(
      () => sql<{ count: string }[]>`
        select count(*)::text as count from messages where "sessionId" = ${SESSION_ID}
      `,
      (r) => Number(r[0]?.count ?? 0) >= 2,
      (r) => `${r[0]?.count ?? 0} rows`,
    )

    // The stored title stays NULL -- the name below is derived at query time, not ingested.
    const [stored] = await sql<{ title: string | null }[]>`
      select title from sessions where id = ${SESSION_ID}
    `
    expect(stored?.title).toBeNull()

    await page.goto(`/sessions?project=${PROJECT_SLUG}`)

    // The collector never sets a title -- Claude transcripts carry none, so `sessions.title`
    // is NULL. The list is named by the server's `derivedTitle`, which coalesces that NULL
    // with the opening user prompt, so a captured session is never shown as "untitled".
    const row = page.getByRole("button", { name: /Rescans duplicate rows/ })
    await expect(row).toBeVisible()

    await row.click()
    await expect(page).toHaveURL(new RegExp(`/sessions/${SESSION_ID}$`))
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "Rescans duplicate rows - make ingest idempotent.",
    )

    // The captured turns are what the conversation renders -- scoped to the tabpanel so
    // the assertion cannot be satisfied by the masthead.
    const conversation = page.getByRole("tabpanel")
    await expect(conversation.getByText(/make ingest idempotent/i)).toBeVisible()
    await expect(conversation.getByText(/switch inserts to upserts/i)).toBeVisible()
  })

  test("P5: with no --project-slug override the daemon resolves the project from its git remote and captures it, because projects.json marks it enabled", async () => {
    const { writer, sql } = await useHarness({ projectOverride: false, enabled: true })

    await writer.append([
      userLine("Resolve me from the git remote.", 0),
      assistantLine("Resolved.", 1),
    ])

    await pollUntil(
      () => sql<{ count: string }[]>`
        select count(*)::text as count from messages where "sessionId" = ${SESSION_ID}
      `,
      (r) => Number(r[0]?.count ?? 0) >= 2,
      (r) => `${r[0]?.count ?? 0} rows`,
    )

    // The slug came from `git@github.com:acme/widgets.git` via the daemon's own resolver,
    // not from a flag -- so `shouldCapture` was consulted with the real identity.
    const [project] = await sql<{ slug: string; name: string }[]>`
      select p.slug, p.name from projects p
      join sessions s on s."projectId" = p.id
      where s.id = ${SESSION_ID}
    `
    expect(project?.slug).toBe(PROJECT_SLUG)
    expect(project?.name).toBe("widgets")
  })

  test("P6: a project marked disabled in projects.json is skipped -- the daemon completes cycles and checkpoints nothing, and no rows reach Postgres", async () => {
    const { writer, sql, samskaraHome } = await useHarness({
      projectOverride: false,
      enabled: false,
    })

    await writer.append([
      userLine("This project is disabled.", 0),
      assistantLine("Nothing should be captured.", 1),
    ])

    // "No rows" is also what a dead daemon looks like, so first prove it ran a real cycle:
    // a completed cycle always writes state.json, even when every project was filtered out.
    await awaitCycle(samskaraHome)

    const [{ count } = { count: "0" }] = await sql<{ count: string }[]>`
      select count(*)::text as count from messages where "sessionId" = ${SESSION_ID}
    `
    expect(Number(count)).toBe(0)

    const sessions = await sql<{ id: string }[]>`select id from sessions where id = ${SESSION_ID}`
    expect(sessions).toHaveLength(0)
  })

  test("P7: a rejected upload checkpoints nothing and is retried -- a subagent sidecar arriving before its parent session 409s, then lands once the main transcript exists", async () => {
    const { writer, sql, samskaraHome } = await useHarness()

    // A real production race: the sidecar is written before the main transcript, so the
    // server has no session to attach it to and answers 409.
    await writer.appendSubagent("early", [assistantLine("Ran before the parent existed.", 0)], {
      agentType: "db-schema-auditor",
      description: "Audit unique constraints",
    })

    const sidecarKey = join(writer.projectDir, SESSION_ID, "subagents", "agent-early.jsonl")

    const state = await awaitCycle(samskaraHome)

    // A non-2xx leaves `sentThrough` at 0, so syncTrack returns no checkpoint at all.
    // Were it checkpointed here, the rejected lines would be skipped forever after.
    expect(state?.checkpoints[sidecarKey]).toBeUndefined()

    const orphaned = await sql<{ count: string }[]>`
      select count(*)::text as count from messages where "sessionId" = ${SESSION_ID}
    `
    expect(Number(orphaned[0]?.count)).toBe(0)

    // Now the parent arrives. The sidecar was never checkpointed, so the next cycle
    // re-sends exactly those lines and they finally land.
    await writer.append([
      userLine("Audit the constraints.", 0),
      assistantLine("Delegating to a subagent.", 1),
    ])

    const subagents = await pollUntil(
      () => sql<{ agentId: string }[]>`
        select "agentId" from subagents where "sessionId" = ${SESSION_ID}
      `,
      (r) => r.length >= 1,
      (r) => `${r.length} subagents`,
    )
    expect(subagents[0]?.agentId).toBe("early")

    // The retry must not duplicate: one row for the subagent's single line.
    const flagged = await sql<{ count: string }[]>`
      select count(*)::text as count from messages
      where "sessionId" = ${SESSION_ID} and "isSubagent" = true
    `
    expect(Number(flagged[0]?.count)).toBe(1)
  })

  test("P8: a transcript whose trailing line is still being written is captured only up to its last complete line, and the partial line lands once its newline arrives", async () => {
    const { writer, sql } = await useHarness()

    await writer.append([userLine("First complete line.", 0)])
    // A half-written line, exactly as a transcript looks mid-append: no trailing newline.
    await writeFile(writer.mainPath, '{"type":"user","message":{"role":"user","content":"trunca', {
      flag: "a",
      encoding: "utf8",
    })

    const first = await pollUntil(
      () => sql<{ count: string }[]>`
        select count(*)::text as count from messages where "sessionId" = ${SESSION_ID}
      `,
      (r) => Number(r[0]?.count ?? 0) >= 1,
      (r) => `${r[0]?.count ?? 0} rows`,
    )
    // `completeLines` drops the trailing fragment, so only the finished line is ingested.
    expect(Number(first[0]?.count)).toBe(1)

    // Completing that line makes it whole; the next cycle picks it up.
    await writeFile(writer.mainPath, 'ted"}}\n', { flag: "a", encoding: "utf8" })

    const second = await pollUntil(
      () => sql<{ count: string }[]>`
        select count(*)::text as count from messages where "sessionId" = ${SESSION_ID}
      `,
      (r) => Number(r[0]?.count ?? 0) >= 2,
      (r) => `${r[0]?.count ?? 0} rows`,
    )
    expect(Number(second[0]?.count)).toBe(2)
  })

  test("P9: a transcript containing an unparseable line is skipped without killing the cycle, and a healthy sibling session in the same directory still captures", async () => {
    const { writer, sql, samskaraHome, home, cwd } = await useHarness()

    // A JSON array is valid JSON but not an object, so parseJsonLines raises
    // MalformedLineError and collectTrack drops this whole track.
    await writer.append([userLine("Healthy opening line.", 0)])
    await writeFile(writer.mainPath, "[1,2,3]\n", { flag: "a", encoding: "utf8" })

    const siblingId = "7c2e5a91-4b6d-4f83-9c1a-2e8b7d4f6a30"
    const sibling = createTranscriptWriter({ home, cwd, sessionId: siblingId })
    await sibling.append([
      userLine("Sibling session is fine.", 0),
      assistantLine("And it should still be captured.", 1),
    ])

    // The malformed track must not stop the cycle: the sibling still lands.
    const siblingRows = await pollUntil(
      () => sql<{ count: string }[]>`
        select count(*)::text as count from messages where "sessionId" = ${siblingId}
      `,
      (r) => Number(r[0]?.count ?? 0) >= 2,
      (r) => `${r[0]?.count ?? 0} sibling rows`,
    )
    expect(Number(siblingRows[0]?.count)).toBe(2)

    // The damaged transcript is skipped whole -- including the healthy line above the
    // bad one -- and is never checkpointed, so a later repair can still be picked up.
    const damaged = await sql<{ count: string }[]>`
      select count(*)::text as count from messages where "sessionId" = ${SESSION_ID}
    `
    expect(Number(damaged[0]?.count)).toBe(0)

    const state = await readState(samskaraHome)
    expect(state?.checkpoints[writer.mainPath]).toBeUndefined()

    // Clean up the sibling, which uses a different id than clearPipelineRows removes.
    await sql`delete from sessions where id = ${siblingId}`
  })
})
