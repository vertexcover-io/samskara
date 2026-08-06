import { type SQL, and, asc, desc, eq, gte, lte, sql } from "drizzle-orm"
import type { Querier } from "../db/client.js"
import { projects, repos, sessionChunk, sessions, users } from "../db/schema.js"
import { CANDIDATE_LIMIT, RRF_K, RRF_WEIGHTS, VECTOR_MAX_DISTANCE } from "../search/constants.js"
import type { EmbeddingClient } from "../search/embedding.js"
import { fuseRrf } from "../search/fusion.js"
import { visibleToUser } from "./projects.repo.js"
import {
  type SessionListFilter,
  type SessionSummaryRow,
  derivedTitle,
  dominantRepoId,
  durationMs,
  repoColumns,
  scopeConditions,
  status,
  tokensTotal,
  withRepo,
} from "./sessions.repo.js"

export type RankedSession = SessionSummaryRow & {
  readonly score: number
  readonly snippet: string
  readonly anchorMessageId: string | null
}

/** D1: one chunk-level result from the shared engine, scoped to a single session. */
export type RankedChunk = {
  readonly anchorMessageId: string | null
  readonly snippet: string
  readonly score: number
  readonly startLineNumber: number | null
}

const toVectorLiteral = (vector: ReadonlyArray<number>): string => `[${vector.join(",")}]`

// Shared by every candidate list (keyword, vector, title) so a chunk carries the same session
// summary and snippet regardless of which list surfaced it, and each list stays in sync with the
// others' scoping and shape.
const candidateQuery = (
  db: Querier,
  tsQuery: SQL,
  conditions: ReadonlyArray<SQL | undefined>,
  order: SQL,
  limit: number = CANDIDATE_LIMIT,
) =>
  db
    .select({
      id: sessions.id,
      title: derivedTitle,
      projectName: projects.name,
      projectSlug: projects.slug,
      userLogin: users.githubLogin,
      ...repoColumns,
      durationMs,
      tokensTotal,
      status,
      lastActiveAt: sql<string>`${sessions.updatedAt}`,
      chunkId: sessionChunk.id,
      kind: sessionChunk.kind,
      snippet: sql<string>`ts_headline('english', ${sessionChunk.searchText}, ${tsQuery},
        ${HEADLINE_OPTIONS})`,
      anchorMessageId: sessionChunk.anchorMessageId,
      startLineNumber: sessionChunk.startLineNumber,
    })
    .from(sessionChunk)
    .innerJoin(sessions, eq(sessions.id, sessionChunk.sessionId))
    .innerJoin(projects, eq(projects.id, sessions.projectId))
    .innerJoin(users, eq(users.id, sessions.userId))
    .leftJoin(repos, sql`${repos.id} = ${dominantRepoId}`)
    .where(and(...conditions))
    .orderBy(order)
    .limit(limit)

type ChunkCandidate = Awaited<ReturnType<typeof candidateQuery>>[number]

type FusedChunks = {
  readonly fused: ReadonlyMap<string, number>
  readonly byChunkId: ReadonlyMap<string, ChunkCandidate>
}

/**
 * `ts_headline` marks matches with `<b>` by default, which cannot ship: `searchText` carries
 * arbitrary tool-result content, so returning server-built HTML would hand the client markup it
 * must never render. Matches are delimited with STX/ETX instead -- two control characters that
 * cannot occur in transcript text -- and the client splits on them to render its own element.
 * Nothing crosses the wire as markup, so React's escaping guarantee is untouched.
 *
 * Any `<b>` still present came from the indexed content itself rather than from the marker, and is
 * stripped for the reason it always was.
 */
const HEADLINE_OPTIONS = "StartSel=\u0002, StopSel=\u0003, MaxFragments=1, MaxWords=30, MinWords=12"

const plainSnippet = (row: ChunkCandidate): string => row.snippet.replace(/<\/?b>/g, "")

/**
 * Ranks `sessionChunk` rows over three RRF lists: keyword and vector scans of every chunk,
 * plus a third list restricted to `kind = 'title'` rows, which is what makes the title a list
 * weight rather than a tier -- a title chunk already competes in the general lists like any
 * other chunk, and this third list is *additional* score on top of that. Scoping and the existing
 * session filters are applied in the `WHERE` clause before ranking, reusing `visibleToUser`
 * rather than restating the predicate.
 *
 * Shared by `searchSessions` (global, collapsed to a session's best chunk) and
 * `searchSessionChunks` (D1: the same engine scoped by session id, uncollapsed) -- one ranking
 * path, one fusion, one authorization check for both surfaces.
 */
const rankChunks = async (
  db: Querier,
  userId: string,
  q: string,
  client: EmbeddingClient,
  filter: SessionListFilter,
): Promise<FusedChunks> => {
  const tsQuery = sql`websearch_to_tsquery('english', ${q})`
  const tsVector = sql`to_tsvector('english', ${sessionChunk.searchText})`
  const keywordScore = sql<number>`ts_rank_cd(${tsVector}, ${tsQuery})`
  const conditions = scopeConditions(db, userId, filter)

  const [keywordRows, queryVector] = await Promise.all([
    candidateQuery(
      db,
      tsQuery,
      [...conditions, sql`${tsVector} @@ ${tsQuery}`],
      desc(keywordScore),
    ),
    client.embedQuery(q).catch((error: unknown) => {
      console.error("embedding query failed, degrading to keyword-only search:", error)
      return null
    }),
  ])

  const titleRows = keywordRows.filter((row) => row.kind === "title")

  let vectorRows: ReadonlyArray<ChunkCandidate> = []
  if (queryVector) {
    const distance = sql<number>`${sessionChunk.embedding} <=> ${toVectorLiteral(queryVector)}::vector`
    vectorRows = await candidateQuery(
      db,
      tsQuery,
      [
        ...conditions,
        sql`${sessionChunk.embedding} is not null`,
        sql`${distance} <= ${VECTOR_MAX_DISTANCE}`,
      ],
      asc(distance),
    )
  }

  const fused = fuseRrf(
    [
      { ids: keywordRows.map((row) => row.chunkId), weight: RRF_WEIGHTS.chunkKeyword },
      { ids: vectorRows.map((row) => row.chunkId), weight: RRF_WEIGHTS.chunkVector },
      { ids: titleRows.map((row) => row.chunkId), weight: RRF_WEIGHTS.title },
    ],
    RRF_K,
  )

  const byChunkId = new Map<string, ChunkCandidate>()
  for (const row of [...keywordRows, ...vectorRows]) byChunkId.set(row.chunkId, row)

  return { fused, byChunkId }
}

/** Session score is the best chunk's fused score. */
export const searchSessions = async (
  db: Querier,
  userId: string,
  q: string,
  client: EmbeddingClient,
  filter: SessionListFilter = {},
): Promise<ReadonlyArray<RankedSession>> => {
  const { fused, byChunkId } = await rankChunks(db, userId, q, client, filter)

  const bestPerSession = new Map<string, { readonly chunkId: string; readonly score: number }>()
  for (const [chunkId, score] of fused) {
    const row = byChunkId.get(chunkId)
    if (!row) continue
    const current = bestPerSession.get(row.id)
    if (!current || score > current.score) bestPerSession.set(row.id, { chunkId, score })
  }

  return [...bestPerSession.values()]
    .sort((a, b) => b.score - a.score)
    .map(({ chunkId, score }) => {
      const row = byChunkId.get(chunkId)
      if (!row) throw new Error("unreachable: fused chunk id missing from lookup")
      // `withRepo` folds the three repo columns into the `repo` object the summary shape
      // carries, exactly as `listAccessible` does -- one definition of that shape, not two.
      return withRepo({
        id: row.id,
        title: row.title,
        projectName: row.projectName,
        projectSlug: row.projectSlug,
        userLogin: row.userLogin,
        repoHost: row.repoHost,
        repoOwner: row.repoOwner,
        repoName: row.repoName,
        durationMs: row.durationMs,
        tokensTotal: row.tokensTotal,
        status: row.status,
        lastActiveAt: row.lastActiveAt,
        score,
        snippet: plainSnippet(row),
        anchorMessageId: row.anchorMessageId,
      })
    })
}

/**
 * the same engine, scoped to one session by `filter.sessionId` -- every ranked chunk in that
 * session, not collapsed to a session's best. A long session can have several turns worth
 * surfacing at once, which is exactly the shape global search's one-row-per-session result
 * cannot carry.
 */
export const searchSessionChunks = async (
  db: Querier,
  userId: string,
  sessionId: string,
  q: string,
  client: EmbeddingClient,
): Promise<ReadonlyArray<RankedChunk>> => {
  const { fused, byChunkId } = await rankChunks(db, userId, q, client, { sessionId })

  return [...fused]
    .sort((a, b) => b[1] - a[1])
    .map(([chunkId, score]) => {
      const row = byChunkId.get(chunkId)
      if (!row) throw new Error("unreachable: fused chunk id missing from lookup")
      return {
        anchorMessageId: row.anchorMessageId,
        snippet: plainSnippet(row),
        score,
        startLineNumber: row.startLineNumber,
      }
    })
}
