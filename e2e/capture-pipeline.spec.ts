import { type ChildProcess, execFile, spawn } from "node:child_process"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { SignJWT } from "jose"
import postgres from "postgres"
import { expect, mintSessionToken, test } from "./fixtures/auth.js"
import { API_BASE } from "./playwright.config.js"
import { E2E_OTHER_USER_ID, E2E_USER_ID, seedDatabase } from "./seed.js"
import {
  assistantLine,
  createTranscriptWriter,
  deltaLine,
  secretBearingLine,
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
  /** The cutoff `samskara enable` would have stored; omitted means capture everything. */
  readonly syncFrom?: string
}

/**
 * Boots the real `samskara watch --foreground` daemon against a throwaway HOME.
 * `~/.claude/projects` and `~/.samskara` both live inside it, so the watcher's real
 * glob and its real state file are exercised — no test seam substitutes for either.
 */
const startHarness = async (options: HarnessOptions = {}): Promise<Harness> => {
  const { projectOverride = true, enabled = true, syncFrom } = options
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
                ...(syncFrom === undefined ? {} : { syncFrom }),
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
    // Artifacts cascade from sessions, but the delete is explicit so a leftover row from a
    // failed run cannot satisfy the next test's poll instantly.
    await sql`delete from artifact where "sessionId" = ${SESSION_ID}`
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

    const [project] = await sql<{ id: string }[]>`
      select id from projects where slug = ${PROJECT_SLUG} and "ownerId" = ${E2E_USER_ID}
    `
    if (!project) throw new Error(`no project row for slug ${PROJECT_SLUG}`)
    await page.goto(`/sessions?project=${project.id}`)

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

  test("P10: a syncFrom cutoff in projects.json keeps a session started after it and skips one started before, so enabling a project never retroactively uploads its history", async () => {
    // The writer stamps every line at 2026-06-01T12:00Z, so this cutoff sits after the
    // old session's first line and before the new one's.
    const CUTOFF = new Date(Date.UTC(2026, 5, 1, 12, 30)).toISOString()
    const { sql, home, cwd, samskaraHome } = await useHarness({
      projectOverride: false,
      enabled: true,
      syncFrom: CUTOFF,
    })

    const oldId = "1a1a1a1a-2b2b-4c3c-8d4d-5e5e5e5e5e5e"
    const newId = "9f9f9f9f-8e8e-4d7d-8c6c-5b5b5b5b5b5b"

    // Started at 12:00 -- before the cutoff.
    const older = createTranscriptWriter({ home, cwd, sessionId: oldId })
    await older.append([
      userLine("Recorded before capture was enabled.", 0),
      assistantLine("This history was never opted into.", 1),
    ])

    // Started at 12:40 -- after the cutoff.
    const newer = createTranscriptWriter({ home, cwd, sessionId: newId })
    await newer.append([
      userLine("Started after enabling.", 40),
      assistantLine("This one is captured.", 41),
    ])

    const kept = await pollUntil(
      () => sql<{ count: string }[]>`
        select count(*)::text as count from messages where "sessionId" = ${newId}
      `,
      (r) => Number(r[0]?.count ?? 0) >= 2,
      (r) => `${r[0]?.count ?? 0} rows for the new session`,
    )
    expect(Number(kept[0]?.count)).toBe(2)

    // The pre-cutoff session is skipped WHOLE: not one line of it reaches the server.
    const skipped = await sql<{ count: string }[]>`
      select count(*)::text as count from messages where "sessionId" = ${oldId}
    `
    expect(Number(skipped[0]?.count)).toBe(0)
    const oldSessions = await sql<{ id: string }[]>`select id from sessions where id = ${oldId}`
    expect(oldSessions).toHaveLength(0)

    // Skipped, not merely deferred: it is never checkpointed either, so raising the
    // cutoff later would still let it through.
    const state = await readState(samskaraHome)
    expect(state?.checkpoints[older.mainPath]).toBeUndefined()
    expect(state?.checkpoints[newer.mainPath]).toBeDefined()

    await sql`delete from sessions where id in (${oldId}, ${newId})`
  })

  test("P12: a file written inside the project root is captured, and one outside it never is", async () => {
    // No --project-slug override: only the real resolver derives a project root, and without
    // a root the daemon skips artifact capture entirely.
    const { writer, sql, cwd } = await useHarness({
      projectOverride: false,
      enabled: true,
    })

    const inScope = join(cwd, "docs", "adr-001.md")
    const excluded = join(cwd, "node_modules", "pkg", "index.js")
    const outside = join(cwd, "..", "elsewhere.md")
    await mkdir(join(cwd, "docs"), { recursive: true })
    await mkdir(join(cwd, "node_modules", "pkg"), { recursive: true })
    await writeFile(inScope, "# Decision\n", "utf8")
    await writeFile(excluded, "module.exports = {}\n", "utf8")
    await writeFile(outside, "not part of the project\n", "utf8")

    await writer.append([
      userLine("Write the ADR.", 0),
      toolCallLine("tool-write-1", "Write", { file_path: inScope }, 1),
      toolCallLine("tool-write-2", "Write", { file_path: excluded }, 2),
      toolCallLine("tool-write-3", "Write", { file_path: outside }, 3),
    ])

    // Anchor on the transcript reaching Postgres, so a queue that never appears is
    // distinguishable from a daemon that never ran a cycle.
    await pollUntil(
      () => sql<{ count: string }[]>`
        select count(*)::text as count from messages where "sessionId" = ${SESSION_ID}
      `,
      (r) => Number(r[0]?.count ?? 0) >= 4,
      (r) => `${r[0]?.count ?? 0} message rows`,
    )

    // Exactly the in-scope file reaches Postgres. The dependency directory and the path
    // outside the root are filtered before the queue, so no upload of either is ever possible.
    const rows = await pollUntil(
      () => sql<{ path: string; relativePath: string; changeKind: string }[]>`
        select path, "relativePath", "changeKind" from artifact where "sessionId" = ${SESSION_ID}
      `,
      (r) => r.length > 0,
      (r) => `${r.length} artifact rows`,
    )

    expect(rows.map((row) => row.path)).toEqual([await realpath(inScope)])
    expect(rows[0]?.relativePath).toBe(join("docs", "adr-001.md"))
    expect(rows[0]?.changeKind).toBe("created")

    await sql`delete from artifact where "sessionId" = ${SESSION_ID}`
  })

  test("P13: an edited file's backup pointer resolves into a stored base and diff, while an edit whose delta names no backup lands as editedUnknownBase", async () => {
    const { writer, sql, cwd, home } = await useHarness({
      projectOverride: false,
      enabled: true,
    })

    const resolvable = join(cwd, "docs", "resolvable.md")
    const unknownBase = join(cwd, "docs", "unknown-base.md")
    await mkdir(join(cwd, "docs"), { recursive: true })
    await writeFile(resolvable, "# Notes\n\nChanged line.\n", "utf8")
    await writeFile(unknownBase, "# Other\n\nAlso changed.\n", "utf8")

    // The real backup Claude took before editing the first file. The second has none, which is
    // the measured majority case and must still capture -- as editedUnknownBase.
    const historyDir = join(home, ".claude", "file-history", SESSION_ID)
    await mkdir(historyDir, { recursive: true })
    await writeFile(join(historyDir, "3c32b39a@v1"), "# Notes\n\nOriginal line.\n", "utf8")

    // Claude emits the Edit, then the delta recording the backup it took first. Only the
    // first file's delta names a backup; the second carries null, which is the measured
    // majority case and must still queue the artifact.
    await writer.append([
      userLine("Edit both docs.", 0),
      toolCallLine(
        "tool-edit-1",
        "Edit",
        { file_path: resolvable, old_string: "Original line." },
        1,
      ),
      deltaLine(resolvable, "3c32b39a@v1", 2),
      toolCallLine("tool-edit-2", "Edit", { file_path: unknownBase, old_string: "Was here." }, 3),
      deltaLine(unknownBase, null, 4),
    ])

    await pollUntil(
      () => sql<{ count: string }[]>`
        select count(*)::text as count from messages where "sessionId" = ${SESSION_ID}
      `,
      (r) => Number(r[0]?.count ?? 0) >= 3,
      (r) => `${r[0]?.count ?? 0} message rows`,
    )

    const rows = await pollUntil(
      () => sql<
        {
          path: string
          changeKind: string
          baseContent: Buffer | null
          diff: string | null
          oldFragment: string | null
        }[]
      >`
        select path, "changeKind", "baseContent", diff, "oldFragment"
        from artifact where "sessionId" = ${SESSION_ID}
      `,
      (r) => r.length >= 2,
      (r) => `${r.length} artifact rows`,
    )

    const byPath = new Map(rows.map((row) => [row.path, row]))
    const withBackup = byPath.get(await realpath(resolvable))
    const withoutBackup = byPath.get(await realpath(unknownBase))

    // The pointer carried the pre-edit content all the way from `file-history` into the column.
    expect(withBackup?.changeKind).toBe("edited")
    expect(withBackup?.baseContent?.toString("utf8")).toBe("# Notes\n\nOriginal line.\n")
    expect(withBackup?.diff).toContain("-Original line.")
    expect(withBackup?.diff).toContain("+Changed line.")

    // No backup: captured anyway, honestly recorded as unrecoverable, keeping the fragment.
    expect(withoutBackup?.changeKind).toBe("editedUnknownBase")
    expect(withoutBackup?.baseContent).toBeNull()
    expect(withoutBackup?.oldFragment).toBe("Was here.")

    await sql`delete from artifact where "sessionId" = ${SESSION_ID}`
  })

  test("P14: a captured report's referenced media is captured too, under the same session, while a source file it links is not", async () => {
    // No --project-slug override: artifact capture needs the real resolver's project root, and
    // the tracked-reference filter needs the real `git ls-files` against this fixture repo.
    const { writer, sql, cwd } = await useHarness({ projectOverride: false, enabled: true })

    const verification = join(cwd, "verification")
    const report = join(verification, "proof-report.html")
    const video = join(verification, "run.mp4")
    const shot = join(verification, "shot.png")
    const source = join(cwd, "src", "driver.ts")
    await mkdir(verification, { recursive: true })
    await mkdir(join(cwd, "src"), { recursive: true })

    // Written by agent-browser driven from Bash: nothing in the transcript names them, which is
    // exactly why the write-tool path cannot see them.
    await writeFile(video, Buffer.from("000000186674797069736f6d", "hex"))
    await writeFile(shot, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))

    // Committed, so the real `git ls-files` reports it tracked and the reference is rejected.
    await writeFile(source, "export const drive = () => {}\n", "utf8")
    await execFileAsync("git", ["add", "src/driver.ts"], { cwd })
    await execFileAsync(
      "git",
      [
        "-c",
        "user.email=e2e@example.com",
        "-c",
        "user.name=e2e",
        "commit",
        "-q",
        "-m",
        "add driver",
      ],
      { cwd },
    )

    await writeFile(
      report,
      [
        "<h1>Verification</h1>",
        '<video src="run.mp4" poster="shot.png"></video>',
        '<a href="../src/driver.ts">driver.ts</a>',
        '<img src="https://example.com/remote.png">',
      ].join("\n"),
      "utf8",
    )

    // Only the report is declared. Everything else has to be reached through its references.
    await writer.append([
      userLine("Verify the feature and write the report.", 0),
      toolCallLine("tool-write-report", "Write", { file_path: report }, 1),
    ])

    await pollUntil(
      () => sql<{ count: string }[]>`
        select count(*)::text as count from messages where "sessionId" = ${SESSION_ID}
      `,
      (r) => Number(r[0]?.count ?? 0) >= 2,
      (r) => `${r[0]?.count ?? 0} message rows`,
    )

    // Three rows: the declared report plus the two files it references. The referenced pair
    // arrives on a later worker pass, after the report's own upload has settled.
    const rows = await pollUntil(
      () => sql<{ path: string; relativePath: string; changeKind: string; mimeType: string }[]>`
        select path, "relativePath", "changeKind", "mimeType"
        from artifact where "sessionId" = ${SESSION_ID}
      `,
      (r) => r.length >= 3,
      (r) => `${r.length} artifact rows`,
    )

    const byRelative = new Map(rows.map((row) => [row.relativePath, row]))
    expect([...byRelative.keys()].sort()).toEqual([
      join("verification", "proof-report.html"),
      join("verification", "run.mp4"),
      join("verification", "shot.png"),
    ])

    // Inherited attribution, never inferred: the media carries the report's own session.
    expect(byRelative.get(join("verification", "run.mp4"))?.changeKind).toBe("created")
    expect(byRelative.get(join("verification", "run.mp4"))?.mimeType).toBe("video/mp4")
    expect(byRelative.get(join("verification", "shot.png"))?.changeKind).toBe("created")

    // The tracked source file and the remote URL are both absent, and neither is a near miss:
    // the assertion above pins the row set exactly.
    expect(rows.some((row) => row.path === source)).toBe(false)

    await sql`delete from artifact where "sessionId" = ${SESSION_ID}`
  })

  test("A1: a file the agent edits during a captured session arrives in Postgres with its pre-session content and a diff, without delaying message capture", async () => {
    // No --project-slug: the override path supplies no project root, so it would enqueue nothing.
    const { writer, sql, cwd, home } = await useHarness({
      projectOverride: false,
      enabled: true,
    })

    const notes = join(cwd, "docs", "notes.md")
    const ORIGINAL = "# Notes\n\nThe original line.\n"
    const CHANGED = "# Notes\n\nThe replacement line.\n"
    const FINAL = "# Notes\n\nThe third line.\n"

    await mkdir(join(cwd, "docs"), { recursive: true })
    await writeFile(notes, ORIGINAL, "utf8")

    // The backup Claude Code itself takes before an edit, in its real on-disk layout.
    const backupHash = "a1f0e9d8"
    const historyDir = join(home, ".claude", "file-history", SESSION_ID)
    await mkdir(historyDir, { recursive: true })
    await writeFile(join(historyDir, `${backupHash}@v1`), ORIGINAL, "utf8")

    await writeFile(notes, CHANGED, "utf8")

    await writer.append([
      userLine("Rewrite the notes.", 0),
      toolCallLine(
        "tool-edit-a1",
        "Edit",
        { file_path: notes, old_string: "The original line." },
        1,
      ),
      deltaLine(notes, `${backupHash}@v1`, 2),
      userLine("Thanks, anything else worth noting?", 3),
      assistantLine("Nothing further -- the notes now read correctly.", 4),
    ])

    const resolvedPath = await realpath(notes)

    const [artifact] = await pollUntil(
      () => sql<
        {
          currentContent: Buffer | null
          baseContent: Buffer | null
          diff: string | null
          changeKind: string
          relativePath: string
          editCount: number
        }[]
      >`
        select "currentContent", "baseContent", diff, "changeKind", "relativePath", "editCount"
        from artifact where "sessionId" = ${SESSION_ID} and path = ${resolvedPath}
      `,
      (rows) => rows.length === 1 && rows[0]?.baseContent !== null,
      (rows) =>
        `${rows.length} artifact rows (base ${rows[0]?.baseContent === null ? "null" : "set"})`,
    )
    if (!artifact) throw new Error("no artifact row reached Postgres")

    // Bytes, not strings: base64/utf8 confusion anywhere on the path would show up here.
    expect(artifact.currentContent?.toString("utf8")).toBe(CHANGED)
    expect(artifact.baseContent?.toString("utf8")).toBe(ORIGINAL)
    expect(artifact.changeKind).toBe("edited")
    expect(artifact.relativePath).toBe(join("docs", "notes.md"))
    expect(artifact.editCount).toBe(1)

    // A real unified diff, carrying both sides of the change.
    expect(artifact.diff).toContain("-The original line.")
    expect(artifact.diff).toContain("+The replacement line.")

    // Artifact work did not stall ingest: the conversational turns landed too.
    const messageRows = await pollUntil(
      () => sql<{ count: string }[]>`
        select count(*)::text as count from messages where "sessionId" = ${SESSION_ID}
      `,
      (r) => Number(r[0]?.count ?? 0) >= 4,
      (r) => `${r[0]?.count ?? 0} message rows`,
    )
    expect(Number(messageRows[0]?.count)).toBeGreaterThanOrEqual(4)

    // A further edit: one row still, base frozen, editCount incremented.
    await writeFile(notes, FINAL, "utf8")
    await writer.append([
      toolCallLine(
        "tool-edit-a1b",
        "Edit",
        { file_path: notes, old_string: "The replacement line." },
        5,
      ),
      deltaLine(notes, `${backupHash}@v1`, 6),
    ])

    const updated = await pollUntil(
      () => sql<{ currentContent: Buffer | null; baseContent: Buffer | null; editCount: number }[]>`
        select "currentContent", "baseContent", "editCount"
        from artifact where "sessionId" = ${SESSION_ID} and path = ${resolvedPath}
      `,
      (rows) => rows.length === 1 && (rows[0]?.editCount ?? 0) >= 2,
      (rows) => `${rows.length} rows, editCount ${rows[0]?.editCount ?? 0}`,
    )
    expect(updated).toHaveLength(1)
    expect(updated[0]?.currentContent?.toString("utf8")).toBe(FINAL)
    // The base is frozen: a re-derived base would be post-edit content and every later diff wrong.
    expect(updated[0]?.baseContent?.toString("utf8")).toBe(ORIGINAL)
    expect(updated[0]?.editCount).toBe(2)

    await sql`delete from artifact where "sessionId" = ${SESSION_ID}`
  })

  test("A2: artifacts captured by the real daemon read back through the API, and hostile content is served defused -- a claimed type is never echoed, and HTML and SVG land in an opaque origin", async () => {
    const { writer, sql, cwd } = await useHarness({ projectOverride: false, enabled: true })

    // Everything an agent plausibly writes, including the two shapes that turn a captured file
    // into stored XSS if the server trusts what the client claimed about it.
    const REPORT_HTML =
      "<!doctype html><html><body><script>alert(document.cookie)</script></body></html>"
    const DIAGRAM_SVG = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
    const SCRIPT_JS = "export const beacon = () => fetch('https://evil.example')\n"

    await mkdir(join(cwd, "docs"), { recursive: true })
    const report = join(cwd, "docs", "report.html")
    const diagram = join(cwd, "docs", "diagram.svg")
    const script = join(cwd, "docs", "beacon.js")
    await writeFile(report, REPORT_HTML, "utf8")
    await writeFile(diagram, DIAGRAM_SVG, "utf8")
    await writeFile(script, SCRIPT_JS, "utf8")

    await writer.append([
      userLine("Write the report, the diagram, and the helper.", 0),
      toolCallLine("tool-write-a2a", "Write", { file_path: report }, 1),
      toolCallLine("tool-write-a2b", "Write", { file_path: diagram }, 2),
      toolCallLine("tool-write-a2c", "Write", { file_path: script }, 3),
    ])

    await pollUntil(
      () => sql<{ count: string }[]>`
        select count(*)::text as count from artifact where "sessionId" = ${SESSION_ID}
      `,
      (r) => Number(r[0]?.count ?? 0) >= 3,
      (r) => `${r[0]?.count ?? 0} artifact rows`,
    )

    const token = await mintSessionToken()
    const read = (path: string) =>
      fetch(`${API_BASE}${path}`, { headers: { authorization: `Bearer ${token}` } })

    const listed = await read(`/api/sessions/${SESSION_ID}/artifacts`)
    expect(listed.status).toBe(200)
    const { artifacts } = (await listed.json()) as {
      artifacts: { id: string; relativePath: string; byteSize: number }[]
    }

    const byPath = new Map(artifacts.map((row) => [row.relativePath, row]))
    const html = byPath.get(join("docs", "report.html"))
    const svg = byPath.get(join("docs", "diagram.svg"))
    const js = byPath.get(join("docs", "beacon.js"))
    if (!html || !svg || !js) throw new Error(`missing artifacts: ${[...byPath.keys()].join(", ")}`)
    expect(html.byteSize).toBe(Buffer.byteLength(REPORT_HTML))

    // The .js the agent wrote is served as inert text. Were its claimed type echoed, this URL
    // would be loadable via `<script src>` from our own origin -- stored XSS by upload.
    const rawJs = await read(`/api/artifacts/${js.id}/raw`)
    expect(rawJs.status).toBe(200)
    expect(rawJs.headers.get("content-type")).toBe("text/plain; charset=utf-8")
    expect(rawJs.headers.get("x-content-type-options")).toBe("nosniff")
    expect(await rawJs.text()).toBe(SCRIPT_JS)

    // HTML and SVG both render, both in an opaque origin. `allow-same-origin` alongside
    // `allow-scripts` would cancel the sandbox entirely, so neither may ever carry it.
    for (const [row, body] of [
      [html, REPORT_HTML],
      [svg, DIAGRAM_SVG],
    ] as const) {
      const res = await read(`/api/artifacts/${row.id}/raw`)
      expect(res.status).toBe(200)
      expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8")

      const csp = res.headers.get("content-security-policy") ?? ""
      expect(csp).toContain("sandbox allow-scripts")
      expect(csp).toContain("default-src 'none'")
      expect(csp).not.toContain("allow-same-origin")
      expect(res.headers.get("x-content-type-options")).toBe("nosniff")

      // Served unmodified: the protection is the origin, not rewriting the body.
      expect(await res.text()).toBe(body)
    }

    // The detail route carries the text content the list route deliberately withheld.
    const detail = await read(`/api/artifacts/${html.id}`)
    expect(detail.status).toBe(200)
    const detailBody = (await detail.json()) as { artifact: { currentContent: string | null } }
    expect(detailBody.artifact.currentContent).toBe(REPORT_HTML)

    // A real, authenticated user with no grant on this project. Both routes answer 404 rather
    // than 403, so nothing about the artifact's existence leaks through the refusal.
    const stranger = await mintSessionToken(E2E_OTHER_USER_ID)
    const asStranger = (path: string) =>
      fetch(`${API_BASE}${path}`, { headers: { authorization: `Bearer ${stranger}` } })

    expect((await asStranger(`/api/artifacts/${html.id}`)).status).toBe(404)
    expect((await asStranger(`/api/artifacts/${html.id}/raw`)).status).toBe(404)
    expect((await asStranger(`/api/sessions/${SESSION_ID}/artifacts`)).status).toBe(404)

    await sql`delete from artifact where "sessionId" = ${SESSION_ID}`
  })

  test("A2: a viewer opens a captured session in the browser and reads the real artifact and its diff, with no demo fixture present and no access for a stranger", async ({
    authedPage: page,
  }) => {
    const { writer, sql, cwd, home } = await useHarness({
      projectOverride: false,
      enabled: true,
    })

    // A1's capture, run again so a real edited artifact with a real diff exists to read back.
    const notes = join(cwd, "docs", "notes.md")
    const ORIGINAL = "# Notes\n\nThe original line.\n"
    const CHANGED = "# Notes\n\nThe replacement line.\n"

    await mkdir(join(cwd, "docs"), { recursive: true })
    await writeFile(notes, ORIGINAL, "utf8")

    const backupHash = "b2c1d0e9"
    const historyDir = join(home, ".claude", "file-history", SESSION_ID)
    await mkdir(historyDir, { recursive: true })
    await writeFile(join(historyDir, `${backupHash}@v1`), ORIGINAL, "utf8")

    await writeFile(notes, CHANGED, "utf8")

    await writer.append([
      userLine("Rewrite the notes.", 0),
      toolCallLine(
        "tool-edit-a2ui",
        "Edit",
        { file_path: notes, old_string: "The original line." },
        1,
      ),
      deltaLine(notes, `${backupHash}@v1`, 2),
    ])

    const resolvedPath = await realpath(notes)
    await pollUntil(
      () => sql<{ diff: string | null }[]>`
        select diff from artifact
        where "sessionId" = ${SESSION_ID} and path = ${resolvedPath}
      `,
      (rows) => rows.length === 1 && rows[0]?.diff !== null,
      (rows) => `${rows.length} artifact rows (diff ${rows[0]?.diff === null ? "null" : "set"})`,
    )

    // The owning user opens the session the daemon just captured.
    await page.goto(`/sessions/${SESSION_ID}`)
    await page.getByRole("tab", { name: /Artifacts/ }).click()

    // The browser nests files under folder rows, so the folder carries the path and the leaf
    // carries the file name.
    const list = page.getByRole("list", { name: /filed artifacts/i })
    await expect(list.getByRole("button", { name: /^docs$/ })).toBeVisible()
    const file = list.getByRole("button", { name: /notes\.md/ })
    await expect(file).toBeVisible()

    // Selecting it shows the diff the daemon computed, both sides of the change.
    await file.click()
    const viewer = page.getByRole("region", { name: /artifact viewer/i })
    await expect(viewer.getByText("-The original line.")).toBeVisible()
    await expect(viewer.getByText("+The replacement line.")).toBeVisible()

    // No fixture from the deleted DEMO_ARTIFACTS survives anywhere on the rendered page.
    const body = (await page.locator("body").textContent()) ?? ""
    for (const fixture of ["architecture.svg", "walkthrough.mp4", "idempotent-ingest.md"]) {
      expect(body).not.toContain(fixture)
    }

    // A real, authenticated user with no grant on this project is refused on both routes.
    const stranger = await mintSessionToken(E2E_OTHER_USER_ID)
    const asStranger = (path: string) =>
      fetch(`${API_BASE}${path}`, { headers: { authorization: `Bearer ${stranger}` } })

    const listed = await asStranger(`/api/sessions/${SESSION_ID}/artifacts`)
    expect(listed.status).toBe(404)

    const [row] = await sql<{ id: string }[]>`
      select id from artifact where "sessionId" = ${SESSION_ID} and path = ${resolvedPath}
    `
    if (!row) throw new Error("no artifact row to probe the raw route with")
    expect((await asStranger(`/api/artifacts/${row.id}/raw?which=current`)).status).toBe(404)

    await sql`delete from artifact where "sessionId" = ${SESSION_ID}`
  })

  test("P11: credentials in a transcript are redacted before upload, so no secret reaches the raw column that stores the whole line", async () => {
    const { writer, sql } = await useHarness()

    await writer.append([userLine("Call the API with my credentials.", 0), secretBearingLine(1)])

    await pollUntil(
      () => sql<{ count: string }[]>`
        select count(*)::text as count from messages where "sessionId" = ${SESSION_ID}
      `,
      (r) => Number(r[0]?.count ?? 0) >= 2,
      (r) => `${r[0]?.count ?? 0} rows`,
    )

    // Search every persisted column, not just `raw`: the tool input is copied into the
    // toolCall details too, and a leak in either place is a leak.
    const [leak] = await sql<{ hits: string }[]>`
      select count(*)::text as hits from messages m
      left join "toolCall" t on t."messageId" = m.id
      where m."sessionId" = ${SESSION_ID}
        and (m.raw::text like '%DEADBEEF%'
             or coalesce(m.details::text, '') like '%DEADBEEF%'
             or coalesce(t."toolInput"::text, '') like '%DEADBEEF%')
    `
    expect(Number(leak?.hits)).toBe(0)

    // The redaction ran rather than the line being dropped, and it is surgical:
    // `tokenizer` and the prose containing "token" are untouched.
    const [row] = await sql<{ raw: unknown }[]>`
      select raw from messages
      where "sessionId" = ${SESSION_ID} and "msgType" = 'toolCall'
    `
    const rawText = JSON.stringify(row?.raw)
    expect(rawText).toContain("[Redacted]")
    expect(rawText).toContain("keep-me")
    expect(rawText).toContain("the literal word token appears here")
  })
})
