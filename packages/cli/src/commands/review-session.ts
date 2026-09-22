import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { homedir as realHomedir, tmpdir } from "node:os"
import { basename, join } from "node:path"
import {
  type AiReviewPayload,
  buildReviewPrompt,
  buildSessionExport,
  capAgentLog,
  createClaudePlugin,
  createClaudeRunner,
  createLogger,
  createOpencodeRunner,
  DEFAULT_REVIEW_MODEL,
  type HarnessRunner,
  type HarnessRunnerResult,
  missingCredentialMessage,
  type NormalizedMessage,
  parseReviewXml,
  REVIEW_HARNESSES,
  REVIEW_MODEL_PATTERN,
  type ReviewHarness,
  reviewContractMd,
  reviewXmlTemplate,
  sessionIndexFrom,
  validateGrounding,
  withDerivedTracks,
} from "@samskara/core"
import { errorMessage, reportError, resolveIo, type Writer } from "../io.js"
import { globAll, nodeFs } from "../watcher/index.js"
import { belongsToSession } from "./replay.js"

/**
 * The session id the reviewer is shown. The real one is withheld on purpose: a harness that
 * can reach `~/.claude/projects` could otherwise look the session up and cite a record the
 * export never gave it, and the grounding gate would have nothing to catch it by.
 */
const ALIAS = "session-under-review"

/** The legacy v1 contract: the review as a fenced XML block in stdout, no file written. */
const STDOUT_REVIEW_RE = /<review[\s>]/

export type ReviewSessionOptions = {
  readonly harness?: string
  readonly model?: string
  readonly timeout?: string
  readonly out?: string
  readonly keep?: boolean
  readonly verbose?: boolean
  /** Commander sets this false for `--no-sandbox-home`; claude only. */
  readonly sandboxHome?: boolean
  readonly dryRun?: boolean
  readonly stdout?: Writer
  readonly stderr?: Writer
  /** Test seams. */
  readonly cwd?: string
  readonly homedir?: () => string
  readonly env?: NodeJS.ProcessEnv
  readonly createRunner?: (spec: RunnerSpec) => HarnessRunner
}

export type RunnerSpec = {
  readonly harness: ReviewHarness
  readonly model: string
  readonly timeoutMs: number
  readonly sandboxHome: boolean
  readonly log: ReturnType<typeof createLogger>
}

type Settings = {
  readonly target: string
  readonly harness: ReviewHarness
  readonly model: string
  readonly timeoutMs: number
  readonly outDir: string
  readonly keep: boolean
  readonly sandboxHome: boolean
  readonly dryRun: boolean
}

const isHarness = (value: string): value is ReviewHarness =>
  (REVIEW_HARNESSES as ReadonlyArray<string>).includes(value)

const settingsFrom = (
  target: string,
  options: ReviewSessionOptions,
  env: NodeJS.ProcessEnv,
): Settings => {
  // Flag first, then the same AI_REVIEW_* variables the server reads, then the built-in
  // default. Which provider prefix a model needs differs per account, so the env override is
  // the difference between one export and passing --model on every run.
  const harness = options.harness ?? env.AI_REVIEW_HARNESS ?? "opencode"
  if (!isHarness(harness))
    throw new Error(`--harness must be one of ${REVIEW_HARNESSES.join(", ")}`)
  const model = options.model ?? env.AI_REVIEW_MODEL ?? DEFAULT_REVIEW_MODEL[harness]
  // Same narrow charset the server enforces at its request boundary: a model id reaches the
  // harness command line, so it is validated rather than quoted and hoped for.
  if (!REVIEW_MODEL_PATTERN.test(model)) throw new Error(`--model "${model}" is not a model id`)
  const timeoutMs = Number(options.timeout ?? env.AI_REVIEW_TIMEOUT_MS ?? 600_000)
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("--timeout must be a number")
  const key = target.replace(/^.*\//, "").replace(/\.jsonl$/, "")
  return {
    target,
    harness,
    model,
    timeoutMs,
    outDir: options.out ?? join(options.cwd ?? process.cwd(), "review-out", key),
    keep: options.keep === true,
    sandboxHome: options.sandboxHome !== false,
    dryRun: options.dryRun === true,
  }
}

/**
 * Every transcript file of one session: the main `ID.jsonl` plus any subagent track beside
 * it. A path argument is taken as given; anything else is matched by id, using the same rule
 * `samskara replay` deletes by.
 */
const transcriptsFor = async (target: string, home: string): Promise<ReadonlyArray<string>> => {
  const all = await globAll(join(home, ".claude", "projects", "**", "*.jsonl"))
  const id = basename(target).replace(/\.jsonl$/, "")
  const matched = all.filter((path) => belongsToSession(path, id))
  return target.endsWith(".jsonl") && !matched.includes(target) ? [target, ...matched] : matched
}

/** Every message of the session, ordered the way the export's seq numbering expects. */
const messagesFor = async (
  files: ReadonlyArray<string>,
  log: ReturnType<typeof createLogger>,
): Promise<{ messages: NormalizedMessage[]; title: string; source: string }> => {
  const batches = await createClaudePlugin(nodeFs).collect(
    { checkpoints: {} },
    {
      fs: nodeFs,
      glob: async () => [...files],
      resolveProject: async () => ({ name: "local", slug: "local" }),
      log,
    },
  )
  const tracks = batches.flatMap((batch) => batch.tracks)
  if (tracks.length === 0) throw new Error("no messages parsed — is the session id right?")
  const messages = [
    ...tracks.flatMap((track) => track.records.flatMap((record) => record.messages)),
  ].sort((left: NormalizedMessage, right: NormalizedMessage) => {
    const byTime = (left.timestamp ?? "").localeCompare(right.timestamp ?? "")
    return byTime !== 0 ? byTime : left.subIndex - right.subIndex
  })
  const main = tracks.find((track) => track.type === "main") ?? tracks[0]
  return {
    messages,
    title: main?.title ?? "untitled session",
    source: main?.source ?? "claude_code",
  }
}

const defaultRunner = (spec: RunnerSpec): HarnessRunner => {
  const byHarness: Readonly<Record<ReviewHarness, () => HarnessRunner>> = {
    claude: () =>
      createClaudeRunner({
        model: spec.model,
        timeoutMs: spec.timeoutMs,
        log: spec.log,
        sandboxHome: spec.sandboxHome,
      }),
    opencode: () =>
      createOpencodeRunner({ model: spec.model, timeoutMs: spec.timeoutMs, log: spec.log }),
  }
  const build: () => HarnessRunner = byHarness[spec.harness]
  return build()
}

const writeJson = (path: string, value: unknown): Promise<void> =>
  writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8")

/**
 * Reviews one locally captured Claude Code session end to end on this machine: export the
 * transcript, hand a coding harness the workspace, then parse and ground-check what it wrote.
 * Nothing touches the server — no login, no ingest, no database — which is what makes it
 * usable on a session that was never captured.
 */
export const reviewSessionCommand = async (
  target: string,
  options: ReviewSessionOptions = {},
): Promise<number> => {
  const { stdout, stderr } = resolveIo(options)
  const home = (options.homedir ?? realHomedir)()
  const env = options.env ?? process.env
  let settings: Settings
  try {
    settings = settingsFrom(target, options, env)
  } catch (error) {
    return reportError(stderr, error)
  }

  const log = createLogger(
    { service: "samskara-review-session" },
    { level: options.verbose === true ? "debug" : "warn" },
  )
  const started = Date.now()
  const step = (name: string): void => {
    const seconds = String(Math.round((Date.now() - started) / 1000)).padStart(4)
    stderr.write(`[${seconds}s] ${name}\n`)
  }

  const files = await transcriptsFor(target, home)
  if (files.length === 0) {
    stderr.write(
      `No transcript found for "${target}" under ${join(home, ".claude", "projects")}.\n`,
    )
    return 1
  }
  step(`found ${files.length} transcript file(s)`)

  if (!settings.dryRun) {
    const missing = missingCredentialMessage(settings.harness, env)
    if (missing !== null) {
      stderr.write(`${missing}\n`)
      return 1
    }
  }

  let exported: Awaited<ReturnType<typeof messagesFor>>
  try {
    exported = await messagesFor(files, log)
  } catch (error) {
    return reportError(stderr, error)
  }
  const { messages, title, source } = exported
  const first = messages[0]?.timestamp
  const last = messages.at(-1)?.timestamp
  const sessionExport = buildSessionExport({
    sessionId: ALIAS,
    title,
    source,
    ...(first === undefined ? {} : { startedAt: first }),
    ...(last === undefined ? {} : { endedAt: last }),
    messages,
  })
  step(`exported ${sessionExport.records.length} records from ${messages.length} messages`)

  const workspaceDir = await mkdtemp(join(tmpdir(), "samskara-review-"))
  try {
    await writeJson(join(workspaceDir, "session.json"), sessionExport)
    await writeFile(join(workspaceDir, "review.xml"), reviewXmlTemplate(), "utf8")
    await writeFile(join(workspaceDir, "CONTRACT.md"), reviewContractMd(), "utf8")
    step(`workspace staged at ${workspaceDir}`)

    await mkdir(settings.outDir, { recursive: true })
    await writeJson(join(settings.outDir, "session.json"), sessionExport)

    const prompt = buildReviewPrompt({ sessionMeta: sessionExport.meta })
    // A dry run stops here, having written all four things the reviewer is handed: the
    // export, the skeleton it fills in, the contract it works to, and the prompt.
    if (settings.dryRun) {
      await writeFile(join(settings.outDir, "review.xml"), reviewXmlTemplate(), "utf8")
      await writeFile(join(settings.outDir, "CONTRACT.md"), reviewContractMd(), "utf8")
      await writeFile(join(settings.outDir, "prompt.txt"), prompt, "utf8")
      step(`dry run: the reviewer's four files written to ${settings.outDir}`)
      return 0
    }

    step(`running ${settings.harness} (${settings.model}) — this takes minutes`)
    const runner = (options.createRunner ?? defaultRunner)({
      harness: settings.harness,
      model: settings.model,
      timeoutMs: settings.timeoutMs,
      sandboxHome: settings.sandboxHome,
      log,
    })
    // A harness that will not start, times out or exits non-zero throws. It is the common
    // failure on a first run -- the CLI is missing, or the provider refuses -- so it reads as
    // a message with the harness's own stderr under it, not as a stack trace.
    let run: HarnessRunnerResult
    try {
      run = await runner.run({
        prompt,
        workspaceDir,
        harness: settings.harness,
        model: settings.model,
      })
    } catch (error) {
      stderr.write(`\nHARNESS FAILED: ${errorMessage(error)}\n`)
      const harnessStderr = (error as { stderr?: string }).stderr
      if (harnessStderr !== undefined && harnessStderr.trim() !== "") {
        stderr.write(`${harnessStderr.trim()}\n`)
      }
      return 1
    }
    step(`harness finished, first byte at ${run.firstByteMs ?? "never"}ms`)

    const file = await readFile(join(workspaceDir, "review.xml"), "utf8").catch(() => "")
    const xml = file.trim() === "" && STDOUT_REVIEW_RE.test(run.stdout) ? run.stdout : file
    await writeFile(join(settings.outDir, "review.xml"), xml, "utf8")
    await writeFile(
      join(settings.outDir, "agent.log"),
      capAgentLog(run.agentLog ?? run.stdout),
      "utf8",
    )

    const parsed = parseReviewXml(xml)
    if (!parsed.ok) {
      stderr.write(`\nUNPARSEABLE: ${parsed.error}\n`)
      stderr.write(`raw XML kept at ${join(settings.outDir, "review.xml")}\n`)
      return 1
    }
    if (parsed.recovered.length > 0) step(`XML healed: ${parsed.recovered.join(", ")}`)

    // The harness never gets to claim these: the runner knows which model it drove, and the
    // export knows which track every seq belongs to.
    const payload = withDerivedTracks(
      { ...parsed.value, model: settings.model, harness: settings.harness } as AiReviewPayload,
      sessionExport.records,
    )
    await writeJson(join(settings.outDir, "review.json"), payload)

    const grounding = validateGrounding(payload, sessionIndexFrom(sessionExport.index))
    if (!grounding.ok) {
      stderr.write("\nUNGROUNDED — the reviewer cited records this session does not have:\n")
      for (const problem of grounding.problems.slice(0, 10)) {
        stderr.write(`  ${problem.path}: ${problem.problem}\n`)
      }
      stderr.write(`\n(review.json was still written so you can inspect it)\n`)
      return 1
    }
    step("grounded")
    report(payload, settings.outDir, stdout)
    return 0
  } finally {
    if (settings.keep) stderr.write(`workspace kept at ${workspaceDir}\n`)
    else await rm(workspaceDir, { recursive: true, force: true })
  }
}

const RULE = "─".repeat(72)

const report = (payload: AiReviewPayload, outDir: string, stdout: Writer): void => {
  stdout.write(`\n${RULE}\n`)
  stdout.write(`outcome: ${payload.outcome}   friction: ${payload.friction}\n`)
  stdout.write(`\n${payload.summary}\n\n`)
  for (const lens of payload.lenses) {
    if (lens.lens === "timeline") {
      stdout.write(`${RULE}\nTIMELINE (${lens.entries.length})\n`)
      for (const entry of lens.entries) {
        stdout.write(`  [${entry.fromSeq}-${entry.toSeq}] ${entry.kind}: ${entry.title}\n`)
      }
      continue
    }
    stdout.write(`${RULE}\n${lens.lens.toUpperCase()} (${lens.learnings.length})\n`)
    for (const learning of lens.learnings) {
      stdout.write(`  [${learning.severity}] ${learning.category}: ${learning.title}\n`)
      stdout.write(`      ${learning.detail}\n`)
      if (learning.nextTime) stdout.write(`      next time: ${learning.nextTime}\n`)
      if (learning.cost) stdout.write(`      cost: ${learning.cost}\n`)
      const refs = learning.evidence.map((item) => item.messageId).join(", ")
      if (refs) stdout.write(`      evidence: ${refs}\n`)
    }
  }
  stdout.write(`${RULE}\nwritten to ${outDir}\n`)
}
