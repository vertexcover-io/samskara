import { mkdtemp as defaultMkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  BASE_REVIEW_INSTRUCTIONS,
  buildNewPartExport,
  capAgentLog,
  type EarlierReview,
  HARNESS_STATE_DIR,
  type HarnessRunner,
  keepNewPartProblems,
  mergeReviewPrompt,
  missingCredentialMessage,
  type NormalizedMessage,
  type ProblemReview,
  prepareProblems,
  problemReviewFiles,
  type ReaderReplyStore,
  readProblemWorkspace,
} from "@samskara/core"
import type pino from "pino"
import type { Db } from "../../db/client.js"
import type { Env, ReviewHarness } from "../../lib/env.js"
import { savedReaderReplies, saveReaderReply } from "../../repositories/readerReplies.repo.js"
import { problemTitlesOf, replaceReviewProblems } from "../../repositories/reviewProblems.repo.js"
import * as reviewsRepo from "../../repositories/reviews.repo.js"
import { type ReviewableSession, reviewableSession } from "../../repositories/sessions.repo.js"
import { splitNewPart } from "./newPart.js"
import { REVIEW_SESSION_ALIAS, reviewSessionExport } from "./sessionExport.js"
import { transcriptFromClaudeConfigDir, transcriptFromOpencodeDataDir } from "./transcript.js"

/** Per-run reviewer choice: absent fields fall back to the env-driven defaults. */
export type AiReviewOptions = {
  readonly harness?: ReviewHarness
  readonly model?: string
  /** The user's own prompt, any shape, merged into the review's base instructions. */
  readonly prompt?: string
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
  | "promptMergeFailed"

export type AiReviewResult =
  | { readonly kind: "ok"; readonly reviewId: string; readonly review: ProblemReview }
  | { readonly kind: "error"; readonly code: AiReviewErrorCode; readonly detail?: unknown }

export type AiReviewRun = typeof runAiReview

/** The analyzer id this pipeline writes; a re-run is checked against it. */
export const PROBLEMS_ANALYZER = "ai-problems-v2"

/** Stdout excerpt length carried on a failed result — enough to debug, not to leak. */
const STDOUT_EXCERPT_CHARS = 400

/** The run being done: the row the worker claimed. */
export type ReviewRun = {
  readonly id: string
  readonly sessionId: string
  readonly newPartOnly: boolean
  readonly basedOn: string | null
}

/**
 * The readers' replies kept on the review row, so a retry reads only the pieces no earlier try
 * finished. Never throws: a database hiccup costs a reader rerun, never a lost piece.
 */
const readerReplyStore = (db: Db, reviewId: string, log: pino.Logger): ReaderReplyStore => ({
  load: () =>
    savedReaderReplies(db, reviewId).catch((error: unknown) => {
      log.warn(
        { reviewId, err: error },
        "saved reader replies could not be read; every reader runs",
      )
      return new Map<string, string>()
    }),
  save: (pieceHash, reply) =>
    saveReaderReply(db, { reviewId, pieceHash, reply }).catch((error: unknown) => {
      log.warn({ reviewId, pieceHash, err: error }, "a reader reply could not be saved")
    }),
})

/**
 * One AI review, end to end: readers find leads in every piece of the session, then the
 * reviewer checks each lead and writes review.md, and code checks it before anything is saved.
 * Model output is untrusted at every step. The result lands on `run`'s own row.
 */
export const runAiReview = async (
  deps: AiReviewDeps,
  run: ReviewRun,
  options: AiReviewOptions = {},
): Promise<AiReviewResult> => {
  const { db, runner, env, log } = deps
  const { sessionId } = run
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

  // No viewer check: the route checked edit rights before it queued the review.
  const detail = await reviewableSession(db, sessionId)
  if (detail === null) return { kind: "error", code: "sessionNotFound" }

  // loadEnv proved the configured harness authenticates; a request may name the other one.
  const credentialProblem = missingCredentialMessage(harness, deps.credentialEnv ?? process.env)
  if (credentialProblem !== null) {
    log.warn({ sessionId, harness }, "ai review refused: harness has no credential configured")
    return { kind: "error", code: "harnessUnauthenticated", detail: { message: credentialProblem } }
  }

  const part = run.newPartOnly ? await newPartOf(db, run, detail) : null
  // A new-part run whose base is gone has nothing to continue: its session was deleted.
  if (run.newPartOnly && part === null) return { kind: "error", code: "sessionNotFound" }
  const sessionExport =
    part === null
      ? reviewSessionExport({ session: detail.session, messages: detail.messages })
      : part.exported
  const readMessages = part === null ? detail.messages : part.read

  // The review's instructions: ours, or the user's prompt merged into ours first.
  let instructions = BASE_REVIEW_INSTRUCTIONS
  let promptChanges: string | undefined
  if (options.prompt !== undefined) {
    milestone("prompt_merging")
    try {
      const merged = await mergeReviewPrompt(options.prompt, runner, { harness, model })
      instructions = merged.merged
      promptChanges = merged.changes
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log.warn({ sessionId, message }, "ai review prompt merge failed")
      return { kind: "error", code: "promptMergeFailed", detail: { message } }
    }
    milestone("prompt_merged")
  }
  // Before the review: readers read every piece of the session and find leads. The reviewer
  // below checks each lead against the session and writes up the real ones.
  milestone("readers_started")
  let prepared: Awaited<ReturnType<typeof prepareProblems>>
  try {
    prepared = await prepareProblems({
      exported: sessionExport,
      instructions,
      runner,
      run: { harness, model },
      replies: readerReplyStore(db, run.id, log),
      readerConcurrency: env.readerConcurrency,
    })
  } catch (error) {
    // A reader that fails only leaves its piece unread; anything else failing here fails
    // the run like any other harness failure.
    const message = error instanceof Error ? error.message : String(error)
    log.warn({ sessionId, message }, "ai review problem stages failed")
    milestone("harness_failed")
    return { kind: "error", code: "harnessFailed", detail: { message } }
  }
  milestone("readers_done", {
    pieces: prepared.found.pieceCount,
    leads: prepared.found.leads.length,
    failed: prepared.found.failedPieces.length,
    reused: prepared.found.reusedPieces,
  })
  const staged = problemReviewFiles(sessionExport, instructions, prepared.leadsMd, part?.earlier)

  let workspaceDir: string | undefined
  try {
    // Both runners read this same directory: the soft one directly, the microVM at /work.
    workspaceDir = await mkdtemp(join(tmpdir(), "samskara-ai-review-"))
    milestone("workspace_ready")
    for (const [name, text] of Object.entries(staged.files))
      await writeFile(join(workspaceDir, name), text)
    milestone("workspace_staged")

    const prompt = staged.prompt

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

    const read = await readProblemWorkspace({
      workspaceDir,
      records: sessionExport.records,
      instructions,
      prepared,
    })
    if (read.markdown === null) {
      milestone("deliverable_missing")
      log.warn({ sessionId, workspaceDir }, "ai review deliverable missing: no review.md")
      return {
        kind: "error",
        code: "deliverableMissing",
        detail: { stdoutStart: stdout.slice(0, STDOUT_EXCERPT_CHARS) },
      }
    }
    const { markdown, leadAnswers, result } = read
    milestone("deliverable_read", { bytes: Buffer.byteLength(markdown) })
    if (!result.ok) {
      log.warn({ sessionId, errors: result.errors }, "ai review unparseable: review.md")
      milestone("review_unparseable")
      return {
        kind: "error",
        code: "unparseable",
        detail: { errors: result.errors, start: markdown.slice(0, STDOUT_EXCERPT_CHARS) },
      }
    }
    // A new-part run saves only problems that rest on something new.
    const kept =
      part === null
        ? { review: result.review, dropped: [] as string[] }
        : keepNewPartProblems(result.review, part.exported.contextCount)
    const dropped = [...result.dropped, ...kept.dropped]
    if (dropped.length > 0) log.info({ sessionId, dropped }, "ai review dropped problems")
    milestone("grounded")

    const finishedAt = now()
    const signals = {
      model,
      harness,
      reviewMd: markdown,
      dropped,
      ...(part === null
        ? {}
        : { newPart: { basedOn: run.basedOn, contextCount: part.exported.contextCount } }),
      unaccountedLeads: [...result.unaccountedLeads],
      leadCount: prepared.leadIds.length,
      // Kept apart from the problems: what was looked at, and what the reviewer decided.
      leads: staged.files["leads.md"],
      leadAnswers,
      readers: read.readers,
      contract: staged.files["CONTRACT.md"],
      prompt: options.prompt === undefined ? "base" : "custom",
      ...(promptChanges === undefined ? {} : { promptChanges }),
      run: {
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        milestones: [...milestones],
        agentLog: capAgentLog(runnerAgentLog ?? stdout),
        ...(reviewerTranscript === null ? {} : { transcript: reviewerTranscript }),
        recordIds: sessionExport.records.map((record) => record.sourceId ?? null),
      },
    }
    // One transaction: a review row whose problems failed to save would read as a
    // review that found nothing.
    const reviewRow = await db.transaction(async (tx) => {
      const row = await reviewsRepo.finishReview(tx, run.id, {
        outcome: kept.review.outcome,
        summary: kept.review.summary,
        signals: signals as unknown as object,
        lastMessageId: reviewsRepo.lastMessageRead(readMessages),
      })
      await replaceReviewProblems(tx, {
        reviewId: row.id,
        sessionId,
        projectId: detail.session.projectId,
        problems: kept.review.problems,
        records: sessionExport.records,
      })
      return row
    })
    milestone("persisted")
    return { kind: "ok", reviewId: reviewRow.id, review: kept.review }
  } finally {
    if (workspaceDir !== undefined) {
      // A rejection from `finally` replaces the value the try block was about to return, so
      // an un-removable workspace would report an already-persisted review as a failed run.
      // `force` only
      // swallows ENOENT; a stale msb mount or a root-owned file still rejects. Cleanup is
      // best-effort and never the verdict.
      await rm(workspaceDir, { recursive: true, force: true }).catch((error: unknown) => {
        log.warn({ sessionId, workspaceDir, err: error }, "ai review workspace cleanup failed")
      })
    }
  }
}

/**
 * What a new-part run reads: the session split at its base run's last message, the export of
 * the new part with context, and what the shown chain already reported. Null when the base is
 * gone. `read` is every message the run reads, for its own `lastMessageId`. The base's
 * `updatedAt` is its finish time: a run's row is written once, when it finishes.
 */
const newPartOf = async (
  db: Db,
  run: ReviewRun,
  detail: ReviewableSession,
): Promise<{
  readonly exported: ReturnType<typeof buildNewPartExport>
  readonly read: ReviewableSession["messages"]
  readonly earlier: EarlierReview
} | null> => {
  if (run.basedOn === null) return null
  const base = await reviewsRepo.getReview(db, run.basedOn)
  if (base === null) return null
  const after =
    base.lastMessageId === null
      ? null
      : (detail.messages.find((message) => message.id === base.lastMessageId)?.timestamp ?? null)
  const { earlier, fresh } = splitNewPart(detail.messages, { after, finishedAt: base.updatedAt })
  const exported = buildNewPartExport({
    sessionId: REVIEW_SESSION_ALIAS,
    title: detail.session.title ?? detail.session.id,
    source: detail.session.source,
    ...(detail.session.startedAt === null ? {} : { startedAt: detail.session.startedAt }),
    endedAt: detail.session.lastActiveAt,
    earlier: earlier as unknown as ReadonlyArray<NormalizedMessage>,
    fresh: fresh as unknown as ReadonlyArray<NormalizedMessage>,
  })
  const shown = await reviewsRepo.shownRunsOf(db, detail.session.id, PROBLEMS_ANALYZER)
  const contextIds = new Set(
    exported.records.slice(0, exported.contextCount).map((record) => record.sourceId),
  )
  // The base's own last message counts as read too, so the boundary never moves back: it may
  // be a row the export leaves out, and new messages with no time cannot move it forward.
  const baseLast = detail.messages.filter((message) => message.id === base.lastMessageId)
  return {
    exported,
    read: [
      ...baseLast,
      ...earlier.filter(
        (message) => contextIds.has(message.id) && message.id !== base.lastMessageId,
      ),
      ...fresh,
    ],
    earlier: {
      outcome: base.outcome,
      summary: base.summary,
      problemTitles: await problemTitlesOf(
        db,
        shown.map((row) => row.id),
      ),
      contextCount: exported.contextCount,
    },
  }
}
