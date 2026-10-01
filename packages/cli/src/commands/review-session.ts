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
  idsLabel,
  missingCredentialMessage,
  type NormalizedMessage,
  type PreparedProblems,
  type ProblemReview,
  parseReviewXml,
  prepareProblems,
  problemReviewFiles,
  REVIEW_HARNESSES,
  REVIEW_MODEL_PATTERN,
  type ReviewHarness,
  readProblemWorkspace,
  reviewContractMd,
  reviewMdSkeleton,
  reviewXmlTemplate,
  type SessionExport,
  sessionIndexFrom,
  validateGrounding,
  withDerivedTracks,
} from "@samskara/core"
import { configHome } from "../config/paths.js"
import { errorMessage, reportError, resolveIo, type Writer } from "../io.js"
import { globAll, nodeFs } from "../watcher/index.js"
import { belongsToSession } from "./replay.js"
import { resolveReviewInstructions } from "./review-prompt.js"

/**
 * The session id the reviewer is shown. The real one is withheld on purpose: a harness that
 * can reach `~/.claude/projects` could otherwise look the session up and cite a record the
 * export never gave it, and the grounding gate would have nothing to catch it by.
 */
const ALIAS = "session-under-review"

/**
 * The harness wall clock. The problems review reads every message whole, in several stages, so
 * it gets far longer than the lens review's ten minutes.
 */
const DEFAULT_TIMEOUT_MS = { problems: 1_800_000, lenses: 600_000 }

/** The legacy v1 lens contract: the review as a fenced XML block in stdout, no file written. */
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
  /** --lenses: the lens review (review.xml) instead of the problems review. */
  readonly lenses?: boolean
  /** --prompt FILE: the user's own prompt. --no-prompt sets false: ours only, this run. */
  readonly prompt?: string | false
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
  readonly lenses: boolean
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
  const lenses = options.lenses === true
  if (lenses && typeof options.prompt === "string")
    throw new Error("--prompt applies to the problems review only, not to --lenses")
  const timeoutMs = Number(
    options.timeout ??
      env.AI_REVIEW_TIMEOUT_MS ??
      DEFAULT_TIMEOUT_MS[lenses ? "lenses" : "problems"],
  )
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
    lenses,
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

/** The session as records: excerpts for the lens review, every message whole for problems. */
const exportSession = async (
  files: ReadonlyArray<string>,
  log: ReturnType<typeof createLogger>,
  full: boolean,
): Promise<SessionExport> => {
  const { messages, title, source } = await messagesFor(files, log)
  const first = messages[0]?.timestamp
  const last = messages.at(-1)?.timestamp
  return buildSessionExport({
    sessionId: ALIAS,
    title,
    source,
    ...(first === undefined ? {} : { startedAt: first }),
    ...(last === undefined ? {} : { endedAt: last }),
    messages,
    full,
  })
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
 * A harness that will not start, times out or exits non-zero throws. It is the common failure
 * on a first run -- the CLI is missing, or the provider refuses -- so it reads as a message
 * with the harness's own stderr under it, not as a stack trace.
 */
const harnessFailed = (stderr: Writer, error: unknown): number => {
  stderr.write(`\nHARNESS FAILED: ${errorMessage(error)}\n`)
  const harnessStderr = (error as { stderr?: string }).stderr
  if (harnessStderr !== undefined && harnessStderr.trim() !== "")
    stderr.write(`${harnessStderr.trim()}\n`)
  return 1
}

/** What both reviews share once the session is found, exported and a runner can be built. */
type ReviewContext = {
  readonly settings: Settings
  readonly sessionExport: SessionExport
  readonly makeRunner: () => HarnessRunner
  readonly step: (name: string) => void
  readonly stdout: Writer
  readonly stderr: Writer
}

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

  // Checked here, reported after the prompt is resolved: a missing or empty --prompt file
  // is the clearer error. claude with the real HOME signs in with the machine's own login,
  // which is what --no-sandbox-home is for, so it needs no key.
  const missingCredential =
    settings.dryRun || (settings.harness === "claude" && !settings.sandboxHome)
      ? null
      : missingCredentialMessage(settings.harness, env)

  // The run's model settings, used for the merge agent and the reviewer alike.
  const makeRunner = (): HarnessRunner => {
    if (missingCredential !== null) throw new Error(missingCredential)
    return (options.createRunner ?? defaultRunner)({
      harness: settings.harness,
      model: settings.model,
      timeoutMs: settings.timeoutMs,
      sandboxHome: settings.sandboxHome,
      log,
    })
  }

  let instructions: string | undefined
  if (!settings.lenses) {
    const resolved = await resolveReviewInstructions({
      prompt: options.prompt,
      cwd: options.cwd ?? process.cwd(),
      configDir: join(configHome(), "review"),
      stderr,
      createRunner: makeRunner,
      dryRun: settings.dryRun,
    })
    if (resolved.kind === "error") {
      stderr.write(`${resolved.message}\n`)
      return 1
    }
    instructions = resolved.instructions
    step(
      resolved.source === "base"
        ? "using the default prompt"
        : `using your prompt (${resolved.promptPath})${resolved.source === "merged" ? ", merged and saved as the default" : ""}`,
    )
    if (resolved.changes !== undefined && resolved.changes !== "")
      stderr.write(`What your prompt changed:\n${resolved.changes}\n`)
  }
  if (missingCredential !== null) {
    stderr.write(`${missingCredential}\n`)
    return 1
  }

  let sessionExport: SessionExport
  try {
    sessionExport = await exportSession(files, log, !settings.lenses)
  } catch (error) {
    return reportError(stderr, error)
  }
  step(`exported ${sessionExport.records.length} records`)

  const context = { settings, sessionExport, makeRunner, step, stdout, stderr }
  return instructions === undefined ? lensReview(context) : problemsReview(context, instructions)
}

/**
 * The problems review: readers read every piece and find leads, and the reviewer checks each
 * lead against the session and writes the real problems as review.md. A dry run calls no
 * model, so it stages the reviewer with only the leads code finds.
 */
const problemsReview = async (
  { settings, sessionExport, makeRunner, step, stdout, stderr }: ReviewContext,
  instructions: string,
): Promise<number> => {
  let prepared: PreparedProblems | undefined
  if (!settings.dryRun) {
    step("reading the session in pieces")
    try {
      prepared = await prepareProblems({
        exported: sessionExport,
        instructions,
        runner: makeRunner(),
        run: { harness: settings.harness, model: settings.model },
      })
    } catch (error) {
      return harnessFailed(stderr, error)
    }
    const { found } = prepared
    step(
      `readers done: ${found.pieceCount} pieces, ${found.leads.length} leads, ${found.failedPieces.length} failed`,
    )
  }
  const { files: staged, prompt } = problemReviewFiles(
    sessionExport,
    instructions,
    prepared?.leadsMd,
  )

  const workspaceDir = await mkdtemp(join(tmpdir(), "samskara-review-"))
  try {
    for (const [name, text] of Object.entries(staged))
      await writeFile(join(workspaceDir, name), text, "utf8")
    step(`workspace staged at ${workspaceDir}`)

    await mkdir(settings.outDir, { recursive: true })
    for (const [name, text] of Object.entries(staged))
      if (name !== "review.md") await writeFile(join(settings.outDir, name), text, "utf8")

    // Only a dry run skips the readers.
    if (prepared === undefined) {
      await writeFile(join(settings.outDir, "review.md"), reviewMdSkeleton(), "utf8")
      await writeFile(join(settings.outDir, "prompt.txt"), prompt, "utf8")
      step(`dry run: what the reviewer is handed is in ${settings.outDir}`)
      return 0
    }

    step(`running ${settings.harness} (${settings.model}) — this takes minutes`)
    let run: HarnessRunnerResult
    try {
      run = await makeRunner().run({
        prompt,
        workspaceDir,
        harness: settings.harness,
        model: settings.model,
      })
    } catch (error) {
      return harnessFailed(stderr, error)
    }
    step(`harness finished, first byte at ${run.firstByteMs ?? "never"}ms`)

    const read = await readProblemWorkspace({
      workspaceDir,
      records: sessionExport.records,
      instructions,
      prepared,
    })
    await writeFile(join(settings.outDir, "leads-answered.md"), read.leadAnswers, "utf8")
    await writeFile(
      join(settings.outDir, "agent.log"),
      capAgentLog(run.agentLog ?? run.stdout),
      "utf8",
    )
    if (read.markdown === null) {
      stderr.write("\nMISSING: the reviewer left review.md missing or untouched\n")
      return 1
    }
    await writeFile(join(settings.outDir, "review.md"), read.markdown, "utf8")
    const { result } = read
    if (!result.ok) {
      stderr.write("\nUNPARSEABLE: review.md does not follow the format:\n")
      for (const error of result.errors.slice(0, 10)) stderr.write(`  ${error}\n`)
      stderr.write(`review.md kept at ${join(settings.outDir, "review.md")}\n`)
      return 1
    }

    // The runner, not the reviewer, knows which model it drove.
    const payload = {
      ...result.review,
      dropped: result.dropped,
      unaccountedLeads: result.unaccountedLeads,
      readers: read.readers,
      model: settings.model,
      harness: settings.harness,
    }
    await writeJson(join(settings.outDir, "review.json"), payload)
    if (result.dropped.length > 0) {
      stderr.write(
        `\nDROPPED ${result.dropped.length} — problems that broke the format or cited what is not in the session:\n`,
      )
      for (const reason of result.dropped.slice(0, 10)) stderr.write(`  ${reason}\n`)
    }
    const skipped = result.unaccountedLeads
    if (skipped.length > 0)
      stderr.write(
        `\nSKIPPED ${skipped.length} of ${prepared.leadIds.length} leads the reviewer never answered: ${skipped.slice(0, 20).join(", ")}\n`,
      )
    report(result.review, settings.outDir, stdout)
    return 0
  } finally {
    if (settings.keep) stderr.write(`workspace kept at ${workspaceDir}\n`)
    else await rm(workspaceDir, { recursive: true, force: true })
  }
}

/**
 * The lens review: one harness run fills review.xml from the excerpt export, and the result
 * is parsed and ground-checked against it.
 */
const lensReview = async ({
  settings,
  sessionExport,
  makeRunner,
  step,
  stdout,
  stderr,
}: ReviewContext): Promise<number> => {
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
    let run: HarnessRunnerResult
    try {
      run = await makeRunner().run({
        prompt,
        workspaceDir,
        harness: settings.harness,
        model: settings.model,
      })
    } catch (error) {
      return harnessFailed(stderr, error)
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
    lensReport(payload, settings.outDir, stdout)
    return 0
  } finally {
    if (settings.keep) stderr.write(`workspace kept at ${workspaceDir}\n`)
    else await rm(workspaceDir, { recursive: true, force: true })
  }
}

const RULE = "─".repeat(72)

const report = (review: ProblemReview, outDir: string, stdout: Writer): void => {
  stdout.write(`\n${RULE}\n`)
  stdout.write(`outcome: ${review.outcome}   friction: ${review.friction}\n`)
  stdout.write(`\n${review.summary}\n\n`)
  stdout.write(`${RULE}\nPROBLEMS (${review.problems.length})\n`)
  for (const problem of review.problems) {
    stdout.write(`  [${problem.severity}] ${problem.class}, ${problem.fixType}: ${problem.title}\n`)
    stdout.write(`      ${problem.description}\n`)
    stdout.write(`      learning: ${problem.learning}\n`)
    const refs = problem.evidence.map(idsLabel).join(", ")
    stdout.write(`      evidence: ${refs}\n`)
  }
  stdout.write(`${RULE}\nwritten to ${outDir}\n`)
}

const lensReport = (payload: AiReviewPayload, outDir: string, stdout: Writer): void => {
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
