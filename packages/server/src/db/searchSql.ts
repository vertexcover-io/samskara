import {
  SEARCH_DOCUMENT_TEXT,
  type SearchTable,
  searchCap,
  searchVectorExpression,
} from "./schema.js"

export const SEARCH_INDEX_VERSION = "v3" as const
export const SEARCH_VECTOR_COLUMN = "searchVector" as const

export type SearchSourceKind = "session" | "message" | "pullRequest" | "toolCall" | "toolResult"

export type SearchDocument = {
  readonly sourceKind: SearchSourceKind
  readonly table: SearchTable
  readonly indexName: string
  readonly multiplier: number
  /** Uncapped searchable text, qualified by the table name. */
  readonly text: string
  /** The stored `searchVector` column's generating expression. */
  readonly vector: string
}

export type SearchFilterIndex = {
  readonly indexName: string
  readonly table: "messages" | "commits" | "pullRequests"
  readonly definition: string
  readonly where?: string
}

const document = (
  sourceKind: SearchSourceKind,
  table: SearchTable,
  multiplier: number,
): SearchDocument => ({
  sourceKind,
  table,
  multiplier,
  indexName: `${table}_session_search_${SEARCH_INDEX_VERSION}_idx`,
  text: SEARCH_DOCUMENT_TEXT[table],
  vector: searchVectorExpression(SEARCH_DOCUMENT_TEXT[table]),
})

/** Multipliers weight a hit by where it was found; a session title outranks a tool result. */
export const SEARCH_DOCUMENTS: ReadonlyArray<SearchDocument> = [
  document("session", "sessions", 4),
  document("message", "messages", 1.5),
  document("pullRequest", "pullRequests", 3),
  document("toolCall", "toolCall", 1),
  document("toolResult", "toolResult", 0.75),
]

/** The capped text the stored vector was built from, re-aliased for a runtime `ts_headline`. */
export const searchText = (document: SearchDocument, alias: string): string =>
  searchCap(document.text.replaceAll(`"${document.table}".`, `${alias}.`))

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
  `create index "${document.indexName}" on "${document.table}" using gin ("${SEARCH_VECTOR_COLUMN}") with (fastupdate=off)`

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
