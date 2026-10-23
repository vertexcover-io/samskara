import { type ChildProcess, execFile, spawn } from "node:child_process"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import postgres from "postgres"
import { cliVersion } from "../packages/cli/src/version.js"
import { createCodexTranscriptWriter } from "./codex-transcript.js"
import { requireDatabaseUrl } from "./db.js"
import { expect, mintCliToken, mintSessionToken, test } from "./fixtures/auth.js"
import { assertApiAcceptsCliToken, daemonEnv, pollUntil, stopWatcher } from "./pipeline.js"
import { API_BASE } from "./playwright.config.js"
import { E2E_OTHER_USER_ID, E2E_USER_ID, orgId, seedDatabase } from "./seed.js"
import {
  aiTitleLine,
  assistantLine,
  createTranscriptWriter,
  customTitleLine,
  oldCliTaskNotificationLine,
  secretBearingLine,
  summaryLine,
  toolCallLine,
  toolResultLine,
  userLine,
  writeResultLine,
} from "./transcript.js"

const DATABASE_URL = requireDatabaseUrl()
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url))
const CLI_ENTRY = join(REPO_ROOT, "packages/cli/src/index.ts")

const SESSION_ID = "0b9d4c1e-7f3a-4c22-9a6e-1d5f8b2c3e40"
const PROJECT_SLUG = "acme-widgets"
const PROJECT_NAME = "acme-widgets"
// `resolveProject` turns this remote into the slug `acme-widgets`, matching PROJECT_SLUG.
const GIT_REMOTE = "git@github.com:acme/widgets.git"

const execFileAsync = promisify(execFile)

type Sql = ReturnType<typeof postgres>

type Harness = {
  readonly home: string
  readonly samskaraHome: string
  readonly cwd: string
  readonly sql: Sql
  readonly writer: ReturnType<typeof createTranscriptWriter>
  /** stdout from the real `samskara enable` run; only set when `viaEnable` was used. */
  readonly enableOutput?: string
  stop(): Promise<void>
}

type HarnessOptions = {
  readonly codex?: boolean
  /** What `projects.json` records for this project; omit the entry entirely with `null`. */
  readonly enabled?: boolean | null
  /** The cutoff `samskara enable` would have stored; omitted means capture everything. */
  readonly syncFrom?: string
  /**
   * Drives the real `samskara enable <cwd>` instead of writing `projects.json` and spawning
   * `watch --foreground` directly -- so the harness proves the actual command a user runs,
   * including the project registration it performs and the daemon it starts on its own.
   */
  readonly viaEnable?: boolean
}

/**
 * Boots the real `samskara watch --foreground` daemon against a throwaway HOME.
 * `~/.claude/projects` and `~/.samskara` both live inside it, so the watcher's real
 * glob and its real state file are exercised — no test seam substitutes for either.
 */
const startHarness = async (options: HarnessOptions = {}): Promise<Harness> => {
  const { enabled = true, syncFrom, viaEnable = false } = options
  const home = await mkdtemp(join(tmpdir(), "samskara-e2e-"))
  const samskaraHome = join(home, ".samskara")
  const cwd = join(home, "work", PROJECT_NAME)
  await mkdir(cwd, { recursive: true })
  await mkdir(samskaraHome, { recursive: true })
  if (options.codex) await mkdir(join(home, ".codex"), { recursive: true })

  // A real git remote, so the daemon's own resolver derives `acme-widgets` from it. Without
  // this the slug would be the machine-specific path.
  await execFileAsync("git", ["init", "-q"], { cwd })
  await execFileAsync("git", ["remote", "add", "origin", GIT_REMOTE], { cwd })
  if (options.codex) await createCodexTranscriptWriter(home, cwd, SESSION_ID).start()

  // The watcher only captures projects marked enabled, and reads its token from disk —
  // both are the real files `samskara login` and `samskara enable` would have written.
  await writeFile(join(samskaraHome, "token"), await mintCliToken(), "utf8")
  if (!viaEnable) {
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
  }

  await assertApiAcceptsCliToken()
  const env = daemonEnv(home, samskaraHome)

  let child: ChildProcess | undefined
  let enableOutput: string | undefined
  if (viaEnable) {
    // `--all`: the fixture transcripts carry a fixed 2026-06-01 timestamp, which a default
    // now-cutoff would exclude as "recorded before enabling".
    const result = await execFileAsync("bun", [CLI_ENTRY, "enable", cwd, "--all"], {
      cwd: REPO_ROOT,
      env,
    })
    enableOutput = result.stdout
  } else {
    child = spawn("bun", [CLI_ENTRY, "watch", "--foreground"], {
      cwd: REPO_ROOT,
      env: { ...env, SAMSKARA_DAEMON: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    })
    const logs: string[] = []
    child.stdout?.on("data", (chunk: Buffer) => logs.push(chunk.toString()))
    child.stderr?.on("data", (chunk: Buffer) => logs.push(chunk.toString()))
    child.on("exit", (code) => {
      if (code !== 0 && code !== null) {
        logs.push(`watcher exited with code ${code}`)
      }
    })
  }

  const sql = postgres(DATABASE_URL)

  return {
    home,
    samskaraHome,
    cwd,
    sql,
    writer: createTranscriptWriter({ home, cwd, sessionId: SESSION_ID }),
    ...(enableOutput === undefined ? {} : { enableOutput }),
    stop: async () => {
      const pid =
        child?.pid ??
        Number.parseInt(
          (await readFile(join(samskaraHome, "watch.pid"), "utf8").catch(() => "")).trim(),
          10,
        )
      if (Number.isFinite(pid)) await stopWatcher(pid)
      await sql.end()
      await rm(home, { recursive: true, force: true })
    },
  }
}

let harness: Harness

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
  // Stop the daemon first: it holds a connection and writes rows while the seed truncates.
  await harnessTeardown()
  // Clears every row and (re)creates the E2E user the CLI token is subject to.
  await seedDatabase({ projects: [] })
})

const harnessTeardown = async (): Promise<void> => {
  if (harness) await harness.stop()
}

test.afterEach(harnessTeardown)

test.describe("capture pipeline", () => {
  test.describe.configure({ timeout: 45_000 })

  test("Codex: native history reaches the viewer, late results, artifacts, restart, search and replay", async ({
    authedPage: page,
  }) => {
    const { home, cwd, sql, samskaraHome } = await useHarness({ codex: true, viaEnable: true })
    const writer = createCodexTranscriptWriter(home, cwd, SESSION_ID)
    await pollUntil(
      () => sql`select * from messages where "sessionId" = ${SESSION_ID} and role = 'user'`,
      (rows) => rows.length === 1,
      (rows) => `${rows.length} native prompts`,
    )
    await writer.finish()
    await pollUntil(
      () =>
        sql`select * from messages where "sessionId" = ${SESSION_ID} and "msgType" = 'toolResult'`,
      (rows) => rows.length === 1,
      (rows) => `${rows.length} terminal results`,
    )
    await pollUntil(
      () => sql`select * from artifact where "sessionId" = ${SESSION_ID}`,
      (rows) => rows.length === 2,
      (rows) => `${rows.length} artifacts`,
    )
    await page.goto(`/sessions/${SESSION_ID}`)
    await expect(page.getByText("Native Codex capture complete", { exact: true })).toBeVisible()
    await expect(page.getByText("Codex", { exact: true }).first()).toBeVisible()
    const detail = await fetch(`${API_BASE}/api/sessions/${SESSION_ID}`, {
      headers: { cookie: `session=${await mintSessionToken()}` },
    }).then((response) => response.json())
    expect(detail).toMatchObject({
      tokenUsageAvailable: false,
      session: { source: "codex", modelSnapshot: "gpt-5.4" },
    })
    const before = await sql`select id from messages where "sessionId" = ${SESSION_ID}`
    await execFileAsync("bun", [CLI_ENTRY, "restart"], {
      env: daemonEnv(home, samskaraHome),
      cwd: REPO_ROOT,
    })
    await writer.resume()
    await pollUntil(
      () => sql`select id from messages where "sessionId" = ${SESSION_ID}`,
      (rows) => rows.length === before.length + 3,
      (rows) => `${rows.length} records after resume`,
    )
    const search = await fetch(`${API_BASE}/api/sessions?q=Resumed%20Codex`, {
      headers: { cookie: `session=${await mintSessionToken()}` },
    }).then((response) => response.json())
    expect(JSON.stringify(search)).toContain(SESSION_ID)
    await execFileAsync("bun", [CLI_ENTRY, "replay", SESSION_ID], {
      env: daemonEnv(home, samskaraHome),
      cwd: REPO_ROOT,
    })
    await pollUntil(
      () => sql`select id from messages where "sessionId" = ${SESSION_ID}`,
      (rows) => rows.length === before.length + 3,
      (rows) => `${rows.length} records after replay`,
    )
  })

  test("SC15: the real CLI reads an old-format task notification and it is not shown as the user's words", async () => {
    const { writer, sql } = await useHarness()

    await writer.append([
      userLine("Kick off the bootstrap and tell me when it lands.", 0),
      oldCliTaskNotificationLine('Background command "Bootstrap" completed (exit code 0)', 1),
    ])

    const rows = await pollUntil(
      () => sql<{ subType: string | null; role: string | null }[]>`
        select "subType", role from messages
        where "sessionId" = ${SESSION_ID} and "msgType" = 'message'
        order by "lineNumber"
      `,
      (r) => r.length >= 2,
      (r) => `${r.length} message rows [${r.map((m) => m.subType ?? "null").join(", ")}]`,
    )

    expect(rows.map((r) => r.subType)).toEqual([null, "taskNotification"])
    expect(rows.every((r) => r.role === "user")).toBe(true)
  })

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

    const versions = await sql<{ cliVersion: string }[]>`
      select "cliVersion" from "userCliVersion"
      where "userId" = ${E2E_USER_ID} and "projectId" = ${session.projectId}
    `
    expect(versions.map((row) => row.cliVersion)).toEqual([cliVersion])

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

    // Sessions without an explicit title fall back to the opening prompt in the list.
    const row = page.getByRole("link", { name: /Rescans duplicate rows/ })
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

  test("P5: the daemon resolves the project from its git remote and captures it, because projects.json marks it enabled", async () => {
    const { writer, sql } = await useHarness({ enabled: true })

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

  test("SC45: real `samskara enable` in an org repo, then a captured session appears in the org project for another member", async ({
    authedPage: page,
    context,
  }) => {
    // The global beforeEach's plain seed clears every e2e user's org links; this test needs
    // both minted as members of `acme`, with auto-add on.
    await seedDatabase({ projects: [], orgMembers: { acme: ["primary", "other"] } })

    const { writer, sql, samskaraHome, enableOutput } = await useHarness({ viaEnable: true })

    expect(enableOutput).toContain("acme")

    const projectsFile = JSON.parse(
      await readFile(join(samskaraHome, "projects.json"), "utf8"),
    ) as { projects: Record<string, { projectId?: string }> }
    const storedProjectId = projectsFile.projects[PROJECT_SLUG]?.projectId
    if (!storedProjectId) throw new Error("`samskara enable` did not store a projectId")

    await writer.append([
      userLine("Captured through a real enable.", 0),
      assistantLine("Resolved via enable.", 1),
    ])

    await pollUntil(
      () => sql<{ count: string }[]>`
        select count(*)::text as count from messages where "sessionId" = ${SESSION_ID}
      `,
      (r) => Number(r[0]?.count ?? 0) >= 2,
      (r) => `${r[0]?.count ?? 0} rows`,
    )

    const [project] = await sql<{ id: string; ownerOrgId: string | null }[]>`
      select id, "ownerOrgId" from projects where slug = ${PROJECT_SLUG}
    `
    if (!project) throw new Error(`no project row for slug ${PROJECT_SLUG}`)
    expect(project.id).toBe(storedProjectId)
    expect(project.ownerOrgId).toBe(orgId("acme"))

    const [repo] = await sql<{ ownerOrgId: string | null; ownerUserId: string | null }[]>`
      select "ownerOrgId", "userId" as "ownerUserId" from repos
      where host = 'github.com' and owner = 'acme' and "repoName" = 'widgets'
    `
    expect(repo).toMatchObject({ ownerOrgId: orgId("acme"), ownerUserId: null })

    const [session] = await sql<{ projectId: string }[]>`
      select "projectId" from sessions where id = ${SESSION_ID}
    `
    expect(session?.projectId).toBe(project.id)

    const otherToken = await mintSessionToken(E2E_OTHER_USER_ID)
    await context.addCookies([
      {
        name: "session",
        value: otherToken,
        domain: "localhost",
        path: "/",
        httpOnly: true,
        sameSite: "Lax",
      },
    ])
    await page.goto(`/sessions?project=${project.id}`)
    await expect(page.getByRole("link", { name: /Captured through a real enable/ })).toBeVisible()
  })

  test("P6: a project marked disabled in projects.json is skipped -- the daemon completes cycles and checkpoints nothing, and no rows reach Postgres", async () => {
    const { writer, sql, samskaraHome } = await useHarness({
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
      () => sql<{ agentId: string; agentType: string | null }[]>`
        select "agentId", "agentType" from subagents where "sessionId" = ${SESSION_ID}
      `,
      (r) => r.length >= 1,
      (r) => `${r.length} subagents`,
    )
    expect(subagents[0]?.agentId).toBe("early")
    expect(subagents[0]?.agentType).toBe("db-schema-auditor")

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
  })

  test("P10: a syncFrom cutoff in projects.json keeps a session started after it and skips one started before, so enabling a project never retroactively uploads its history", async () => {
    // The writer stamps every line at 2026-06-01T12:00Z, so this cutoff sits after the
    // old session's first line and before the new one's.
    const CUTOFF = new Date(Date.UTC(2026, 5, 1, 12, 30)).toISOString()
    const { sql, home, cwd, samskaraHome } = await useHarness({
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
  })

  test("P12: a file written inside the project root is captured, and one outside it never is", async () => {
    const { writer, sql, cwd } = await useHarness({
      enabled: true,
    })

    const inScope = join(cwd, "docs", "adr-001.md")
    const excluded = join(cwd, "node_modules", "pkg", "index.js")
    const outsideDir = await mkdtemp(join(REPO_ROOT, "e2e", "fixtures", "p12-outside-"))
    const outside = join(outsideDir, "elsewhere.md")
    await mkdir(join(cwd, "docs"), { recursive: true })
    await mkdir(join(cwd, "node_modules", "pkg"), { recursive: true })
    await writeFile(inScope, "# Decision\n", "utf8")
    await writeFile(excluded, "module.exports = {}\n", "utf8")
    await writeFile(outside, "not part of the project\n", "utf8")

    await writer.append([
      userLine("Write the ADR.", 0),
      toolCallLine("tool-write-1", "Write", { file_path: inScope }, 1),
      writeResultLine("tool-write-1", inScope, { type: "create" }, 1),
      toolCallLine("tool-write-2", "Write", { file_path: excluded }, 2),
      writeResultLine("tool-write-2", excluded, { type: "create" }, 2),
      toolCallLine("tool-write-3", "Write", { file_path: outside }, 3),
      writeResultLine("tool-write-3", outside, { type: "create" }, 3),
    ])

    // Anchor on the transcript reaching Postgres, so a queue that never appears is
    // distinguishable from a daemon that never ran a cycle.
    await pollUntil(
      () => sql<{ count: string }[]>`
        select count(*)::text as count from messages where "sessionId" = ${SESSION_ID}
      `,
      (r) => Number(r[0]?.count ?? 0) >= 7,
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

    await rm(outsideDir, { recursive: true, force: true })
  })

  test("P14: a captured report's referenced media is captured too, under the same session, while a source file it links is not", async () => {
    // The tracked-reference filter needs the real `git ls-files` against this fixture repo.
    const { writer, sql, cwd } = await useHarness({ enabled: true })

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
      writeResultLine("tool-write-report", report, { type: "create" }, 1),
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
  })

  test("A1: a file the agent edits during a captured session arrives in Postgres with its pre-session content and a diff, without delaying message capture, while an edit whose result carries no originalFile lands as editedUnknownBase with no diff", async () => {
    const { writer, sql, cwd } = await useHarness({
      enabled: true,
    })

    const notes = join(cwd, "docs", "notes.md")
    const unknownBase = join(cwd, "docs", "unknown-base.md")
    const ORIGINAL = "# Notes\n\nThe original line.\n"
    const CHANGED = "# Notes\n\nThe replacement line.\n"
    const FINAL = "# Notes\n\nThe third line.\n"

    await mkdir(join(cwd, "docs"), { recursive: true })
    // Only post-edit bytes land on disk; the pre-edit content rides the result line.
    await writeFile(notes, CHANGED, "utf8")
    await writeFile(unknownBase, "# Other\n\nAlso changed.\n", "utf8")

    await writer.append([
      userLine("Rewrite the notes.", 0),
      toolCallLine(
        "tool-edit-a1",
        "Edit",
        { file_path: notes, old_string: "The original line." },
        1,
      ),
      writeResultLine("tool-edit-a1", notes, { type: "update", originalFile: ORIGINAL }, 1),
      toolCallLine("tool-edit-a1u", "Edit", { file_path: unknownBase, old_string: "Was here." }, 2),
      writeResultLine("tool-edit-a1u", unknownBase, { type: "update" }, 2),
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

    const unknownBasePath = await realpath(unknownBase)
    const [withoutBase] = await pollUntil(
      () => sql<{ changeKind: string; baseContent: Buffer | null; diff: string | null }[]>`
        select "changeKind", "baseContent", diff
        from artifact where "sessionId" = ${SESSION_ID} and path = ${unknownBasePath}
      `,
      (rows) => rows.length === 1,
      (rows) => `${rows.length} artifact rows for the unknown-base file`,
    )
    expect(withoutBase?.changeKind).toBe("editedUnknownBase")
    expect(withoutBase?.baseContent).toBeNull()
    expect(withoutBase?.diff).toBeNull()

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
      writeResultLine("tool-edit-a1b", notes, { type: "update" }, 5),
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
  })

  test("A2: artifacts captured by the real daemon read back through the API, and an uploaded type is never echoed -- a .js is served as inert text, while HTML and SVG render same-origin by design", async () => {
    const { writer, sql, cwd } = await useHarness({ enabled: true })

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
      writeResultLine("tool-write-a2a", report, { type: "create" }, 1),
      toolCallLine("tool-write-a2b", "Write", { file_path: diagram }, 2),
      writeResultLine("tool-write-a2b", diagram, { type: "create" }, 2),
      toolCallLine("tool-write-a2c", "Write", { file_path: script }, 3),
      writeResultLine("tool-write-a2c", script, { type: "create" }, 3),
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

    for (const [row, body] of [
      [html, REPORT_HTML],
      [svg, DIAGRAM_SVG],
    ] as const) {
      const res = await read(`/api/artifacts/${row.id}/raw`)
      expect(res.status).toBe(200)
      expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8")
      expect(res.headers.get("content-security-policy")).toBeNull()
      expect(res.headers.get("x-content-type-options")).toBe("nosniff")

      // Served unmodified: nothing rewrites the body on the way out.
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

  test("P15: a `/rename` typed in Claude Code reaches the session's stored title", async () => {
    const { writer, sql } = await useHarness()

    await writer.append([
      userLine("Rescans duplicate rows - make ingest idempotent.", 0),
      assistantLine("Plan: add a unique key, then switch inserts to upserts.", 1),
      customTitleLine("Idempotent ingest fix"),
    ])

    const [stored] = await pollUntil(
      () => sql<{ title: string | null }[]>`select title from sessions where id = ${SESSION_ID}`,
      (rows) => rows.length > 0 && rows[0]?.title !== null,
      (rows) => `title ${JSON.stringify(rows[0]?.title ?? null)}`,
    )
    expect(stored?.title).toBe("Idempotent ingest fix")

    await writer.append([
      assistantLine("Switched the last two call sites over.", 3),
      aiTitleLine("Duplicate row investigation"),
    ])

    const [after] = await pollUntil(
      () => sql<{ title: string | null; count: string }[]>`
        select s.title,
          (select count(*)::text from messages where "sessionId" = ${SESSION_ID}) as count
        from sessions s where s.id = ${SESSION_ID}
      `,
      (rows) => Number(rows[0]?.count ?? 0) >= 3,
      (rows) => `${rows[0]?.count ?? 0} messages, title ${JSON.stringify(rows[0]?.title ?? null)}`,
    )
    expect(after?.title).toBe("Idempotent ingest fix")
  })
})
