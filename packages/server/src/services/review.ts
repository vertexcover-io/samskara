import {
  type LearningCandidate,
  type NormalizedMessage,
  type ReviewEvent,
  type ReviewEventBody,
  reviewEventsFromMessages,
  runReview,
  type SessionReview,
} from "@samskara/core"
import type { Db } from "../db/client.js"
import * as reviewsRepo from "../repositories/reviews.repo.js"
import { getDetail, type SessionDetailRow } from "../repositories/sessions.repo.js"

/**
 * Reviews run against the server's stored projection of a session (the same rows the web UI
 * reads), not against raw transcripts — one analysis path for every source adapter, and the
 * same visibility rule: you can only review a session you can already read.
 */
export const reviewSession = async (
  db: Db,
  userId: string,
  sessionId: string,
): Promise<SessionReview | null> => {
  const detail = await getDetail(db, userId, sessionId)
  if (detail === null) return null
  return reviewFromDetail(sessionId, detail)
}

/**
 * The stored `messages` rows carry the normalized `content` and `details` jsonb exactly as
 * captured, so the projection treats them as NormalizedMessage. Tool naming for results joins
 * by callId inside the projection, exactly as it does on the capture side.
 *
 * The split tables the messages projection cannot see are appended after it: commits and PRs
 * become landing events (the only road to a `shipped` outcome), and the session's token totals
 * fold in from the tokenUsage table as one `tokens` event. Storage moves every transcript token
 * report — owner-attached `tokens` and `usage` lines alike — into that table, so `usage` rows
 * are dropped here to keep the table's totals the single count.
 */
export const reviewFromDetail = (sessionId: string, detail: SessionDetailRow): SessionReview => {
  const messages = (detail.messages as unknown as ReadonlyArray<NormalizedMessage>).filter(
    (message) => message.msgType !== "usage",
  )
  const messageEvents = reviewEventsFromMessages([...messages])
  const bodies: ReviewEventBody[] = [
    ...detail.commits.map((commit): ReviewEventBody => ({ kind: "commit", sha: commit.sha })),
    ...detail.pullRequests.map(
      (pullRequest): ReviewEventBody => ({ kind: "pullRequest", number: pullRequest.number }),
    ),
  ]
  const { inputTokens, outputTokens, cachedTokens, thinkingTokens } = detail.tokenUsage
  if (inputTokens > 0 || outputTokens > 0 || cachedTokens > 0 || thinkingTokens > 0) {
    bodies.push({
      kind: "tokens",
      input: inputTokens,
      output: outputTokens,
      cached: cachedTokens,
      thinking: thinkingTokens,
    })
  }
  const events: ReviewEvent[] = [
    ...messageEvents,
    ...bodies.map((body, index) => ({ ...body, seq: messageEvents.length + index })),
  ]
  return runReview({ sessionId, events })
}

const persistCandidates = async (
  db: Db,
  projectId: string,
  reviewId: string,
  candidates: ReadonlyArray<LearningCandidate>,
): Promise<void> => {
  for (const candidate of candidates) {
    await reviewsRepo.upsertLearning(db, {
      projectId,
      audience: candidate.audience,
      category: candidate.category,
      title: candidate.title,
      detail: candidate.detail,
      evidence: candidate.evidence as unknown as object,
      fingerprint: candidate.fingerprint,
      status: "candidate",
      occurrenceCount: 1,
      sourceReviewId: reviewId,
    })
  }
}

/**
 * Analyze and persist in one pass: the review row first (its id keys the learnings'
 * sourceReviewId), then every candidate as an upsert-by-fingerprint. Re-running on the same
 * session replaces the review and bumps occurrences rather than duplicating.
 */
export const reviewAndPersist = async (
  db: Db,
  userId: string,
  sessionId: string,
): Promise<{ readonly review: SessionReview; readonly reviewId: string } | null> => {
  const review = await reviewSession(db, userId, sessionId)
  if (review === null) return null
  const projectId = await reviewsRepo.sessionProjectId(db, sessionId)
  if (projectId === null) return null

  const row = await reviewsRepo.upsertReview(db, {
    sessionId,
    projectId,
    analyzer: review.analyzer,
    outcome: review.outcome,
    friction: review.friction,
    summary: review.summary,
    signals: review.signals as unknown as object,
  })
  await persistCandidates(db, projectId, row.id, [
    ...review.agentLearnings,
    ...review.humanFeedback,
  ])
  return { review, reviewId: row.id }
}
