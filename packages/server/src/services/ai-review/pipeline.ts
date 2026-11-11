import { mkdtemp as defaultMkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  BASE_REVIEW_INSTRUCTIONS,
  capAgentLog,
  HARNESS_STATE_DIR,
  type HarnessRunner,
  mergeReviewPrompt,
  messageIdOf,
  missingCredentialMessage,
  type ProblemReview,
  prepareProblems,
  problemReviewFiles,
  readProblemWorkspace,
} from "@samskara/core"
import type pino from "pino"
import type { Db } from "../../db/client.js"
import type { Env, ReviewHarness } from "../../lib/env.js"
import {
  appendReviewProblems,
  replaceReviewProblems,
} from "../../repositories/reviewProblems.repo.js"
import * as reviewsRepo from "../../repositories/reviews.repo.js"
import { reviewableSession } from "../../repositories/sessions.repo.js"
import { alreadyReviewedNote, keepNewPart, newPartExport } from "./newPart.js"
import { reviewSessionExport } from "./sessionExport.js"
import { transcriptFromClaudeConfigDir, transcriptFromOpencodeDataDir } from "./transcript.js"

/** Per-run reviewer choice: absent fields fall back to the env-driven defaults. */
export type AiReviewOptions = {
  readonly harness?: ReviewHarness
  readonly model?: string
  /** The user's own prompt, any shape, merged into the review's base instructions. */
  readonly prompt?: string
  /** Read only what the session's earlier review has not, and add to its problems. */
  readonly newPartOnly?: boolean
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

/**
 * One AI review, end to end: readers find leads in every piece of the session, then the
 * reviewer checks each lead and writes review.md, and code checks it before anything is saved.
 * Model output is untrusted at every step. Re-analysis supersedes in place.
 */
export const runAiReview = async (
  deps: AiReviewDeps,
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

  // No viewer check: the route checked edit rights before it queued the review.
  const detail = await reviewableSession(db, sessionId)
  if (detail === null) return { kind: "error", code: "sessionNotFound" }

  // loadEnv proved the configured harness authenticates; a request may name the other one.
  const credentialProblem = missingCredentialMessage(harness, deps.credentialEnv ?? process.env)
  if (credentialProblem !== null) {
    log.warn({ sessionId, harness }, "ai review refused: harness has no credential configured")
    return { kind: "error", code: "harnessUnauthenticated", detail: { message: credentialProblem } }
  }

  const wholeExport = reviewSessionExport({ session: detail.session, messages: detail.messages })
  const reviewedThrough = reviewsRepo.lastLineRead(detail.messages)
  // A nightly re-pick reads only what the earlier review has not; anything else reads it all.
  const earlier =
    options.newPartOnly === true
      ? await reviewsRepo.earlierResult(db, sessionId, PROBLEMS_ANALYZER)
      : null
  const part =
    earlier === null
      ? null
      : newPartExport(
          wholeExport,
          earlier.recordIds,
          reviewsRepo.storedSince(detail.messages, earlier.reviewedThrough),
        )
  if (earlier !== null && part !== null && part.newCount === 0) {
    // Only lines the export drops arrived: nothing to read, but they are seen.
    const row = await reviewsRepo.upsertReview(db, {
      sessionId,
      projectId: detail.session.projectId,
      analyzer: PROBLEMS_ANALYZER,
      outcome: earlier.outcome,
      summary: earlier.summary,
      signals: earlier.signals,
      reviewedThrough,
    })
    milestone("nothing_new")
    return {
      kind: "ok",
      reviewId: row.id,
      review: { outcome: earlier.outcome, summary: earlier.summary, problems: [] },
    }
  }
  const sessionExport = part?.exported ?? wholeExport

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
  // Before the instructions, where readers and reviewer read first; never inside `## Extra fields`.
  if (earlier !== null && part !== null)
    instructions = `${alreadyReviewedNote(earlier, part.firstNew)}\n\n${instructions}`
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
  })
  const staged = problemReviewFiles(sessionExport, instructions, prepared.leadsMd)

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
    if (result.dropped.length > 0)
      log.info({ sessionId, dropped: result.dropped }, "ai review dropped problems")
    milestone("grounded")
    // A re-review adds only problems that show in the new part; the rest were already found.
    const kept =
      part === null
        ? { problems: result.review.problems, dropped: [] as ReadonlyArray<string> }
        : keepNewPart(result.review.problems, part.firstNew)

    const finishedAt = now()
    const signals = {
      model,
      harness,
      reviewMd: markdown,
      dropped: [...result.dropped, ...kept.dropped],
      unaccountedLeads: [...result.unaccountedLeads],
      leadCount: prepared.leadIds.length,
      // Kept apart from the problems: what was looked at, and what the reviewer decided.
      leads: staged.files["leads.md"],
      leadAnswers,
      readers: read.readers,
      contract: staged.files["CONTRACT.md"],
      prompt: options.prompt === undefined ? "base" : "custom",
      ...(promptChanges === undefined ? {} : { promptChanges }),
      ...(part === null ? {} : { newPartFrom: messageIdOf(part.firstNew) }),
      run: {
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        milestones: [...milestones],
        agentLog: capAgentLog(runnerAgentLog ?? stdout),
        ...(reviewerTranscript === null ? {} : { transcript: reviewerTranscript }),
        // Every pass's numbering: old problems' msg-N must keep resolving to their messages.
        recordIds:
          part?.recordIds ?? sessionExport.records.map((record) => record.sourceId ?? null),
      },
    }
    // One transaction: a review row whose problems failed to save would read as a
    // review that found nothing. A re-review adds to the problems; a full review replaces them.
    const reviewRow = await db.transaction(async (tx) => {
      const row = await reviewsRepo.upsertReview(tx, {
        sessionId,
        projectId: detail.session.projectId,
        analyzer: PROBLEMS_ANALYZER,
        outcome: result.review.outcome,
        summary: result.review.summary,
        signals: signals as unknown as object,
        reviewedThrough,
      })
      const save = part === null ? replaceReviewProblems : appendReviewProblems
      await save(tx, {
        reviewId: row.id,
        sessionId,
        projectId: detail.session.projectId,
        problems: kept.problems,
      })
      return row
    })
    milestone("persisted")
    return {
      kind: "ok",
      reviewId: reviewRow.id,
      review: { ...result.review, problems: kept.problems },
    }
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
