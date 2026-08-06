/** One ranked list contributing to a fused score: a list of ids in rank order, and its weight. */
export type RankedList = {
  readonly ids: ReadonlyArray<string>
  readonly weight: number
}

/**
 * Reciprocal Rank Fusion: each id's score is the sum, across every list it appears in, of
 * `weight / (k + rank)` with `rank` 1-based. Rank position rather than the list's raw score --
 * `ts_rank_cd` and cosine distance share no scale, and blending them directly is the failure mode
 * RRF exists to avoid.
 */
export const fuseRrf = (lists: ReadonlyArray<RankedList>, k: number): Map<string, number> => {
  const scores = new Map<string, number>()
  for (const { ids, weight } of lists) {
    ids.forEach((id, index) => {
      const rank = index + 1
      scores.set(id, (scores.get(id) ?? 0) + weight / (k + rank))
    })
  }
  return scores
}
