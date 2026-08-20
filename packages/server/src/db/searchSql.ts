export const SEARCH_INDEX_VERSION = "v2" as const

export type SearchSourceKind = "session" | "message" | "pullRequest" | "toolCall" | "toolResult"

export type SearchDocument = {
  readonly sourceKind: SearchSourceKind
  readonly table: "sessions" | "messages" | "pullRequests" | "toolCall" | "toolResult"
  readonly indexName: string
  readonly multiplier: number
  readonly vector: string
}

export type SearchFilterIndex = {
  readonly indexName: string
  readonly table: "messages" | "commits" | "pullRequests"
  readonly definition: string
  readonly where?: string
}

const cap = (value: string): string => `public.samskara_search_cap(${value})`
const jsonText = (column: string): string =>
  `public.samskara_search_json_text(coalesce(${column}, '{}'::jsonb))`
const vector = (value: string): string => `to_tsvector('simple'::regconfig, ${cap(value)})`

/**
 * `concat_ws` is STABLE in PostgreSQL and therefore cannot appear in an expression index. These
 * immutable equivalents produce the same searchable lexemes for the nullable fields here and are
 * used for indexes, matches, ranks, and snippets alike. Keep them structurally identical at every
 * use.
 */
// PostgreSQL deparses left-associative concatenation with its parse-tree nesting. Spell that tree
// explicitly so runtime expressions and pg_get_indexdef retain the same meaningful structure.
const sessionDocument = `((coalesce("sessions"."title", '') || ' ') || "sessions"."id")`
const messageDocument = `(((("messages"."id"::text || ' ') || ${jsonText('"messages"."content"')}) || ' ') || ${jsonText('"messages"."details"')})`
const toolCallDocument = `(("toolCall"."toolId" || ' ') || ${jsonText('"toolCall"."toolInput"')})`
const toolResultDocument = `(("toolResult"."toolId" || ' ') || ${jsonText('"toolResult"."result"')})`

/**
 * These expressions are the only searchable documents in V1. Keep the values identical wherever
 * they are used: expression indexes, matches, ranks, and snippets.
 */
export const SEARCH_DOCUMENTS: ReadonlyArray<SearchDocument> = [
  {
    sourceKind: "session",
    table: "sessions",
    indexName: "sessions_session_search_v2_idx",
    multiplier: 4,
    vector: vector(sessionDocument),
  },
  {
    sourceKind: "message",
    table: "messages",
    indexName: "messages_session_search_v2_idx",
    multiplier: 1.5,
    vector: vector(messageDocument),
  },
  {
    sourceKind: "pullRequest",
    table: "pullRequests",
    indexName: "pullRequests_session_search_v2_idx",
    multiplier: 3,
    vector: vector(`coalesce("pullRequests"."title", '')`),
  },
  {
    sourceKind: "toolCall",
    table: "toolCall",
    indexName: "toolCall_session_search_v2_idx",
    multiplier: 1,
    vector: vector(toolCallDocument),
  },
  {
    sourceKind: "toolResult",
    table: "toolResult",
    indexName: "toolResult_session_search_v2_idx",
    multiplier: 0.75,
    vector: vector(toolResultDocument),
  },
]

export const SEARCH_FILTER_INDEXES: ReadonlyArray<SearchFilterIndex> = [
  {
    indexName: "messages_session_filter_branch_v1_idx",
    table: "messages",
    definition: `"gitBranch", "sessionId"`,
    where: `"gitBranch" is not null`,
  },
  {
    indexName: "commits_session_filter_repo_v1_idx",
    table: "commits",
    definition: `"repoId", "sessionId"`,
  },
  {
    indexName: "commits_session_filter_branch_v1_idx",
    table: "commits",
    definition: `"branch", "sessionId"`,
    where: `"branch" is not null`,
  },
  {
    indexName: "commits_session_filter_sha_v1_idx",
    table: "commits",
    definition: `lower("sha") text_pattern_ops, "sessionId"`,
  },
  {
    indexName: "pullRequests_session_filter_number_v1_idx",
    table: "pullRequests",
    definition: `"number", "id"`,
  },
  {
    indexName: "pullRequests_session_filter_base_branch_v1_idx",
    table: "pullRequests",
    definition: `"baseBranch", "id"`,
    where: `"baseBranch" is not null`,
  },
  {
    indexName: "pullRequests_session_filter_head_branch_v1_idx",
    table: "pullRequests",
    definition: `"headBranch", "id"`,
    where: `"headBranch" is not null`,
  },
]

export const searchIndexDefinition = (document: SearchDocument): string =>
  `create index "${document.indexName}" on "${document.table}" using gin (${document.vector})`

export const filterIndexDefinition = (index: SearchFilterIndex): string => {
  const predicate = index.where === undefined ? "" : ` where ${index.where}`
  return `create index "${index.indexName}" on "${index.table}" (${index.definition})${predicate}`
}

/** Normalize insignificant PostgreSQL deparser differences before drift comparisons. */
export const normalizeIndexDefinition = (value: string): string =>
  value
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/public\./g, "")
    .replace(/"/g, "")
    .replace(/(?:sessions|messages|pullrequests|toolcall|toolresult)\./g, "")
    .replace(/\(([a-z]+)\)::/g, "$1::")
    .replace(/' '::text/g, "' '")
    .replace(/''::text/g, "''")
    .replace(/ using btree /g, " ")
    // PostgreSQL wraps a top-level partial-index predicate; retain all other parentheses because
    // they encode expression nesting and must participate in drift detection.
    .replace(/ where \(([^()]+)\)$/g, " where $1")
    .trim()
