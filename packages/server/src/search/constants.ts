export const CHUNK_MAX_MESSAGES = 20

/** Well under Postgres's 1 MB tsvector ceiling, which throws at insert time. */
export const SEARCH_TEXT_MAX_BYTES = 200_000

export const RRF_K = 60

export const RRF_WEIGHTS = {
  chunkKeyword: 1,
  chunkVector: 1,
  title: 2,
} as const

/**
 * Cosine distance ceiling past which a chunk is not a match. Model-dependent and measured, not
 * guessed: against mxbai-embed-large, true matches land at 0.14-0.31 and unrelated text at
 * 0.53-0.69, so 0.45 sits in the gap. Re-measure after changing EMBEDDING_MODEL by embedding a
 * query that should match nothing and putting the ceiling below the closest distance it returns.
 */
export const VECTOR_MAX_DISTANCE = 0.45

/** Fusion runs in application memory, so each ranked list is bounded. */
export const CANDIDATE_LIMIT = 200

export const EMBEDDING_DIMENSIONS = 1024

export const EMBEDDING_MAX_ATTEMPTS = 5

export const EMBEDDING_LEASE_MINUTES = 5
