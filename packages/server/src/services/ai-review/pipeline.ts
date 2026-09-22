import { mkdtemp as defaultMkdtemp, open, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type AiReviewPayload,
  buildReviewPrompt,
  buildSessionExport,
  capAgentLog,
  type EvidenceRef,
  fingerprintOf,
  type GroundingProblem,
  HARNESS_STATE_DIR,
  type HarnessRunner,
  type LearningCandidate,
  type LearningCategory,
  missingCredentialMessage,
  type NormalizedMessage,
  parseReviewXml,
  reviewContractMd,
  reviewXmlTemplate,
  sessionIndexFrom,
  validateGrounding,
  withDerivedTracks,
} from "@samskara/core"
import type pino from "pino"
import type { Db } from "../../db/client.js"
import type { Env, ReviewHarness } from "../../lib/env.js"
import { canWrite } from "../../repositories/projects.repo.js"
import * as reviewsRepo from "../../repositories/reviews.repo.js"
import { getDetail } from "../../repositories/sessions.repo.js"
import { persistCandidates } from "../review.js"
import { transcriptFromClaudeConfigDir, transcriptFromOpencodeDataDir } from "./transcript.js"

/** Per-run reviewer choice: absent fields fall back to the env-driven defaults. */
export type AiReviewOptions = {
  readonly harness?: ReviewHarness
  readonly model?: string
}

export type AiReviewDeps = {
  readonly db: Db
  readonly runner: HarnessRunner
  readonly env: Env
  readonly log: pino.Logger
  readonly now?: () => Date
  readonly mkdtemp?: typeof defaultMkdtemp
  /**
   * Optional hook the registry installs so the CLI's progress line can name the latest
   * pipeline phase. The pipeline still logs every milestone with `elapsedMs` — this is the
   * second consumer, the one a watching human sees without tailing the server log.
   */
  readonly onMilestone?: (name: string) => void
  /** Where the harness credential is read from; production is the real environment. */
  readonly credentialEnv?: NodeJS.ProcessEnv
}

/** Every way an AI review run can refuse to persist, named for the API surface above it. */
export type AiReviewErrorCode =
  | "sessionNotFound"
  | "notEditable"
  | "harnessUnauthenticated"
  | "harnessFailed"
  | "deliverableMissing"
  | "unparseable"
  | "invalidSchema"
  | "ungrounded"

export type AiReviewResult =
  | { readonly kind: "ok"; readonly reviewId: string; readonly payload: AiReviewPayload }
  | { readonly kind: "error"; readonly code: AiReviewErrorCode; readonly detail?: unknown }

export type AiReviewRun = typeof runAiReview

/**
 * The analyzer id this pipeline writes. The 409 guards in the routes compare against it, so
 * it is one exported constant rather than a literal repeated at each comparison.
 */
export const AI_ANALYZER = "ai-v1"

/** Stdout excerpt length carried on an `unparseable` result — enough to debug, not to leak. */
const STDOUT_EXCERPT_CHARS = 400

/** The agent chose this file's size, so the read is capped like every other one. */
const MAX_DELIVERABLE_BYTES = 8 * 1024 * 1024

/** Reads at most `MAX_DELIVERABLE_BYTES`, or null when the file is absent or unreadable. */
const readDeliverable = async (path: string): Promise<Buffer | null> => {
  try {
    const handle = await open(path, "r")
    try {
      const buffer = Buffer.alloc(MAX_DELIVERABLE_BYTES)
      const { bytesRead } = await handle.read(buffer, 0, MAX_DELIVERABLE_BYTES, 0)
      return buffer.subarray(0, bytesRead)
    } finally {
      await handle.close()
    }
  } catch {
    return null
  }
}

/** A review root anywhere in stdout — the legacy v1 delivery this pipeline still accepts. */
const STDOUT_REVIEW_RE = /<review(?=[\s/>])/

/**
 * One AI review, end to end. Model output is untrusted at every step: numbers come from the
 * export and the session row, never the model's claims. Re-analysis supersedes in place.
 */
export const runAiReview = async (
  deps: AiReviewDeps,
  userId: string,
  sessionId: string,
  options: AiReviewOptions = {},
): Promise<AiReviewResult> => {
  const { db, runner, env, log } = deps
  const harness = options.harness ?? env.aiReviewHarness
  const model = options.model ?? env.aiReviewModel
  const mkdtemp = deps.mkdtemp ?? defaultMkdtemp
  const now = deps.now ?? (() => new Date())
  // Three consumers: the server log, the persisted run record, and the CLI's progress line.
  const startedAt = now()
  const milestones: Array<{
    readonly name: string
    readonly at: string
    readonly elapsedMs: number
  }> = []
  const milestone = (name: string, extra: Record<string, unknown> = {}): void => {
    const at = now()
    const elapsedMs = at.getTime() - startedAt.getTime()
    milestones.push({ name, at: at.toISOString(), elapsedMs })
    deps.onMilestone?.(name)
    log.info({ sessionId, milestone: name, elapsedMs, ...extra }, "ai review milestone")
  }

  const detail = await getDetail(db, userId, sessionId)
  if (detail === null) return { kind: "error", code: "sessionNotFound" }

  // Editor-gated, because the run writes learnings.
  const editable = await canWrite(db, userId, detail.session.projectId)
  if (!editable) return { kind: "error", code: "notEditable" }

  // loadEnv proved the configured harness authenticates; a request may name the other one.
  const credentialProblem = missingCredentialMessage(harness, deps.credentialEnv ?? process.env)
  if (credentialProblem !== null) {
    log.warn({ sessionId, harness }, "ai review refused: harness has no credential configured")
    return { kind: "error", code: "harnessUnauthenticated", detail: { message: credentialProblem } }
  }

  // The same cast services/review.ts makes: stored jsonb is the captured shape.
  const messages = detail.messages as unknown as ReadonlyArray<NormalizedMessage>
  // Withheld from the reviewer: it is the one key that would let an agent look this session
  // up in its own database and cite ids the export never gave it.
  const REVIEW_SESSION_ALIAS = "session-under-review"
  const sessionExport = buildSessionExport({
    sessionId: REVIEW_SESSION_ALIAS,
    title: detail.session.title ?? detail.session.id,
    source: detail.session.source,
    ...(detail.session.startedAt === null ? {} : { startedAt: detail.session.startedAt }),
    // sessions have no true endedAt column; lastActiveAt is the honest approximation.
    endedAt: detail.session.lastActiveAt,
    messages,
  })

  let workspaceDir: string | undefined
  try {
    // Both runners read this same directory: the soft one directly, the microVM at /work.
    workspaceDir = await mkdtemp(join(tmpdir(), "samskara-ai-review-"))
    milestone("workspace_ready")
    await writeFile(
      join(workspaceDir, "session.json"),
      `${JSON.stringify(sessionExport, null, 2)}\n`,
    )
    milestone("export_written")
    // A file, not a reply: the agent fills the skeleton in incrementally.
    await writeFile(join(workspaceDir, "review.xml"), reviewXmlTemplate())
    milestone("template_staged")
    // In the workspace rather than the prompt, so the agent re-reads rules instead of
    // spending its starting context on the whole spec.
    await writeFile(join(workspaceDir, "CONTRACT.md"), reviewContractMd())
    milestone("contract_staged")

    const prompt = buildReviewPrompt({ sessionMeta: sessionExport.meta })

    milestone("harness_spawning")
    let stdout: string
    let firstByteMs: number | null = null
    let runnerAgentLog: string | undefined
    try {
      const run = await runner.run({ prompt, workspaceDir, harness, model })
      stdout = run.stdout
      firstByteMs = run.firstByteMs
      runnerAgentLog = run.agentLog
      if (run.logPath !== undefined) {
        log.info({ sessionId, logPath: run.logPath }, "ai review agent log captured from sandbox")
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const stderr = (error as { stderr?: string }).stderr
      log.warn({ sessionId, message, stderr, workspaceDir }, "ai review harness run failed")
      milestone("harness_failed")
      // The runner's 2MB cap is right for a log line, far too large to hold in the registry.
      return {
        kind: "error",
        code: "harnessFailed",
        detail: {
          message,
          stderr: stderr === undefined ? undefined : stderr.slice(-STDOUT_EXCERPT_CHARS),
          workspaceDir,
        },
      }
    }
    if (firstByteMs !== null) {
      log.info(
        { sessionId, firstByteMs, workspaceDir },
        "ai review harness produced first stdout byte",
      )
      milestone("harness_first_byte")
    }
    milestone("harness_complete")

    // The reviewer's own session, lifted out of the workspace before cleanup: claude writes
    // a full transcript under its redirected config dir, opencode keeps one in its sqlite
    // database under the redirected XDG dir (the msb guest's XDG lands in the same mounted
    // workspace). It becomes evidence beside the review. A missing transcript degrades to
    // nothing — never a failed review.
    const readTranscript: Readonly<Record<ReviewHarness, typeof transcriptFromOpencodeDataDir>> = {
      opencode: transcriptFromOpencodeDataDir,
      claude: transcriptFromClaudeConfigDir,
    }
    const reviewerTranscript = await readTranscript[harness](
      join(workspaceDir, HARNESS_STATE_DIR[harness]),
    )

    // The deliverable is the file the agent filled in. The workspace is a local dir that
    // survives until cleanup, so it is read back directly; byte count is logged on the
    // milestone. A missing or emptied file falls back to the legacy v1 contract (the fenced
    // XML block in stdout, still supported by the parser); neither source holding a review
    // root at all is `deliverableMissing`, named with the last milestone so the next person
    // knows where the run got stuck.
    const deliverablePath = join(workspaceDir, "review.xml")
    const file = await readDeliverable(deliverablePath)
    let source: string
    let xmlBytes: number
    if (file !== null && file.byteLength > 0) {
      source = file.toString("utf8")
      xmlBytes = file.byteLength
      milestone("deliverable_read", { bytes: xmlBytes })
    } else if (STDOUT_REVIEW_RE.test(stdout)) {
      source = stdout
      xmlBytes = Buffer.byteLength(stdout)
      log.info({ sessionId }, "ai review deliverable fell back to legacy stdout XML")
    } else {
      const lastMilestone = milestones.at(-1)?.name ?? null
      milestone("deliverable_missing")
      log.warn(
        { sessionId, lastMilestone, workspaceDir },
        "ai review deliverable missing: no review.xml and no XML in stdout",
      )
      return {
        kind: "error",
        code: "deliverableMissing",
        detail: { lastMilestone, stdoutStart: stdout.slice(0, STDOUT_EXCERPT_CHARS) },
      }
    }

    // The model-facing contract is XML: locally repairable, salvageable per entry. The
    // parser heals (balancing, escaping, truncation, dropping malformed entries), runs the
    // zod contract, and reports every repair it made in `recovered`.
    const parsed = parseReviewXml(source)
    if (!parsed.ok) {
      log.warn(
        {
          sessionId,
          error: parsed.error,
          recovered: parsed.recovered,
          stdoutStart: source.slice(0, 200),
        },
        "ai review unparseable: harness XML could not be recovered",
      )
      milestone("xml_unparseable")
      return {
        kind: "error",
        code: "unparseable",
        detail: {
          error: parsed.error,
          recovered: parsed.recovered,
          stdoutStart: source.slice(0, STDOUT_EXCERPT_CHARS),
        },
      }
    }
    if (parsed.recovered.length > 0) {
      log.info({ sessionId, recovered: parsed.recovered }, "ai review XML healed")
    }
    milestone("xml_parsed")
    // The model cannot know these reliably; the runner is the authority. The cast is safe:
    // parseReviewXml already ran the full zod contract on this exact object. Tracks join the
    // same list: the export already knows which track every seq belongs to.
    const payload = withDerivedTracks(
      {
        ...parsed.value,
        model,
        harness,
      } as AiReviewPayload,
      sessionExport.records,
    )

    const grounding = validateGrounding(payload, sessionIndexFrom(sessionExport.index))
    if (!grounding.ok) {
      log.warn(
        { sessionId, problems: grounding.problems.slice(0, 10) },
        "ai review ungrounded: claims reference records the session does not have",
      )
      milestone("ungrounded")
      return {
        kind: "error",
        code: "ungrounded",
        detail: { problems: grounding.problems.slice(0, 10) as GroundingProblem[] },
      }
    }
    milestone("grounded")

    // Numbers the model never gets to claim: session span and token totals from the detail
    // row, record/tool-call counts from the export the reviewer actually saw. The span SQL
    // yields ::bigint, which the driver hands back as a string — coerce, like the repo's
    // `countedTokens` does for token sums.
    const numbers = {
      durationMs: detail.session.durationMs === null ? null : Number(detail.session.durationMs),
      recordCount: sessionExport.records.length,
      toolCallCount: sessionExport.records.filter((record) => record.msgType === "toolCall").length,
      inputTokens: detail.tokenUsage.inputTokens,
      outputTokens: detail.tokenUsage.outputTokens,
      cachedTokens: detail.tokenUsage.cachedTokens,
      thinkingTokens: detail.tokenUsage.thinkingTokens,
    }
    // Timeline durations derive from export record ts (epoch ms) at each entry's from/to
    // seq — attached server-side to the persisted copy only; the parsed payload stays
    // contract-pure.
    const tsAt = (seq: number): number | undefined => sessionExport.records[seq]?.ts
    const tsRecords = sessionExport.records.filter((record) => record.ts !== undefined)
    const firstTs = tsRecords[0]?.ts
    const lastTs = tsRecords.at(-1)?.ts
    const totalDurationMs =
      firstTs !== undefined && lastTs !== undefined && lastTs >= firstTs
        ? lastTs - firstTs
        : undefined
    const persistedLenses = payload.lenses.map((lens) =>
      lens.lens === "timeline"
        ? {
            ...lens,
            entries: lens.entries.map((entry) => {
              const startMs = tsAt(entry.fromSeq)
              const endMs = tsAt(entry.toSeq)
              return {
                ...entry,
                ...(startMs === undefined ? {} : { startMs }),
                ...(startMs !== undefined && endMs !== undefined
                  ? { durationMs: endMs - startMs }
                  : {}),
              }
            }),
          }
        : lens,
    )

    // The run record: how the review came to be, for later inspection. The milestone ledger
    // ends at `grounded` — everything after this line is the persistence itself.
    const finishedAt = now()
    const run = {
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      milestones: [...milestones],
      recovered: [...parsed.recovered],
      ...(parsed.selfCounts === undefined ? {} : { selfCounts: parsed.selfCounts }),
      xmlBytes,
      agentLog: capAgentLog(runnerAgentLog ?? stdout),
      ...(reviewerTranscript === null ? {} : { transcript: reviewerTranscript }),
      // seq → the captured message's real id. Evidence citations use export aliases (msg-N);
      // the conversation tab resolves real ids, so the web needs this bridge to build links
      // that actually scroll.
      recordIds: sessionExport.records.map((record) => record.sourceId ?? null),
    }

    // Persist: review first (its id keys the learnings), then every human/agent learning as
    // a candidate — human-check-only curation, same rule as the static path. Harness
    // learnings stay in signals for display: they name what the tooling broke, not advice
    // to re-attribute to a person or the agent.
    //
    // One transaction, because a committed review with no learnings is worse than no review:
    // the job settles as failed while the ai-v1 row is already there, and the retry it
    // prompts is refused with analysisAlreadyExists.
    const reviewRow = await db.transaction(async (tx) => {
      const row = await reviewsRepo.upsertReview(tx, {
        sessionId,
        projectId: detail.session.projectId,
        analyzer: AI_ANALYZER,
        outcome: payload.outcome,
        friction: payload.friction,
        summary: payload.summary,
        signals: {
          model: payload.model,
          harness: payload.harness,
          lenses: persistedLenses,
          ...(payload.partial === undefined ? {} : { partial: payload.partial }),
          numbers,
          ...(totalDurationMs === undefined ? {} : { totalDurationMs }),
          run,
        } as unknown as object,
      })
      await persistCandidates(
        tx,
        detail.session.projectId,
        sessionId,
        row.id,
        learningCandidates(payload),
      )
      return row
    })

    log.info(
      { sessionId, reviewId: reviewRow.id, elapsedMs: now().getTime() - startedAt.getTime() },
      "ai review persisted",
    )
    milestone("persisted")
    return { kind: "ok", reviewId: reviewRow.id, payload }
  } finally {
    if (workspaceDir !== undefined) {
      // A rejection from `finally` replaces the value the try block was about to return, so
      // an un-removable workspace would report an already-persisted review as a failed run —
      // and the retry that prompts then hits 409 analysisAlreadyExists. `force` only
      // swallows ENOENT; a stale msb mount or a root-owned file still rejects. Cleanup is
      // best-effort and never the verdict.
      await rm(workspaceDir, { recursive: true, force: true }).catch((error: unknown) => {
        log.warn({ sessionId, workspaceDir, err: error }, "ai review workspace cleanup failed")
      })
    }
  }
}

/** Harness learnings stay out: they name what the tooling broke, not advice for anyone. */
const learningCandidates = (payload: AiReviewPayload): ReadonlyArray<LearningCandidate> =>
  payload.lenses.flatMap((lens) => {
    if (lens.lens !== "humanLearnings" && lens.lens !== "agentLearnings") return []
    const audience = lens.lens === "humanLearnings" ? "human" : "agent"
    return lens.learnings.map((learning) => ({
      audience,
      // Same hash core's extractor fingerprints with (audience:category:subject); the AI
      // lens categories are wider than the extractor's closed enum, but the hash only
      // concatenates strings, so the cast narrows a type, not a behavior.
      category: learning.category as LearningCategory,
      title: learning.title,
      detail: learning.detail,
      evidence: learning.evidence as unknown as ReadonlyArray<EvidenceRef>,
      fingerprint: fingerprintOf(audience, learning.category as LearningCategory, learning.title),
    }))
  })
