import { MSG_TYPES } from "@samskara/core"
import { sql } from "drizzle-orm"
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"

/**
 * pg-core has no `bytea`, and drizzle-kit's CJS loader cannot resolve this package's `.js`
 * import specifiers, so the type is declared here rather than imported from `customTypes.ts`.
 * `bytea` rather than `text`: artifact content includes real binaries, and base64-in-text would
 * inflate storage by a third and make `length()` meaningless.
 */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
})

const tsvector = customType<{ data: string; driverData: string }>({
  dataType: () => "tsvector",
})

const jsonText = (column: string): string =>
  `public.samskara_search_json_text(coalesce(${column}, '{}'::jsonb))`

/**
 * The searchable text of each table, table-qualified so the runtime headline can re-alias it.
 * Left-associative `||` is spelled with its parse-tree nesting so the deparsed column expression
 * still compares equal. `searchSql.ts` derives the index catalogue from these; they live here
 * because drizzle-kit's loader cannot follow an import out of this file.
 */
export const SEARCH_DOCUMENT_TEXT = {
  sessions: `((coalesce("sessions"."title", '') || ' ') || "sessions"."id")`,
  messages: `(((("messages"."id"::text || ' ') || ${jsonText('"messages"."content"')}) || ' ') || ${jsonText('"messages"."details"')})`,
  pullRequests: `coalesce("pullRequests"."title", '')`,
  toolCall: `(("toolCall"."toolId" || ' ') || ${jsonText('"toolCall"."toolInput"')})`,
  toolResult: `(("toolResult"."toolId" || ' ') || ${jsonText('"toolResult"."result"')})`,
} as const

export type SearchTable = keyof typeof SEARCH_DOCUMENT_TEXT

export const searchCap = (text: string): string => `public.samskara_search_cap(${text})`

export const searchVectorExpression = (text: string): string =>
  `to_tsvector('simple'::regconfig, ${searchCap(text)})`

/** Computed once per write and indexed as a plain column, so no query restates the expression. */
const searchVector = (table: SearchTable) =>
  tsvector("searchVector").generatedAlwaysAs(
    sql.raw(searchVectorExpression(SEARCH_DOCUMENT_TEXT[table])),
  )

const msgTypeValues = MSG_TYPES.map((t) => `'${t}'`).join(", ")

const createdAt = timestamp("createdAt", { withTimezone: true }).notNull().defaultNow()
const updatedAt = timestamp("updatedAt", { withTimezone: true }).notNull().defaultNow()

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  githubId: bigint("githubId", { mode: "number" }).notNull().unique(),
  githubLogin: text("githubLogin").notNull(),
  email: text("email"),
  name: text("name"),
  avatarUrl: text("avatarUrl"),
  isSuperAdmin: boolean("isSuperAdmin").notNull().default(false),
  createdAt,
  updatedAt,
})

export const orgs = pgTable("orgs", {
  id: uuid("id").primaryKey().defaultRandom(),
  githubOrgId: bigint("githubOrgId", { mode: "number" }).unique(),
  githubSlug: text("githubSlug").notNull().unique(),
  name: text("name"),
  autoAddMembers: boolean("autoAddMembers").notNull().default(false),
  createdAt,
  updatedAt,
})

export const repos = pgTable(
  "repos",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    host: text("host").notNull(),
    owner: text("owner").notNull(),
    // Nullable and unconstrained: a remote URL cannot tell a user repo from an org repo, and a
    // PR-derived repo may never have been a cwd. Guessing 'org' asserted a fact we do not have.
    // Out of the identity key for the same reason -- an unknown must not split one repo in two.
    ownerType: text("ownerType"),
    repoName: text("repoName").notNull(),
    userId: uuid("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt,
    updatedAt,
  },
  // Repos are personal, mirroring projects' UNIQUE (slug, ownerId): the same repo seen by two
  // users is two rows. `host` is in the key because github.com/acme/x and gitlab.com/acme/x are
  // genuinely different repos -- and it does not split ssh from https, since `parseRemote`
  // yields the same host string for both forms.
  (t) => [unique("repos_identity_unique").on(t.host, t.owner, t.repoName, t.userId)],
)

export const userOrgs = pgTable(
  "userOrgs",
  {
    userId: uuid("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    orgId: uuid("orgId")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    createdAt,
  },
  (t) => [primaryKey({ columns: [t.userId, t.orgId] }), index("userOrgs_orgId_idx").on(t.orgId)],
)

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    ownerUserId: uuid("ownerId").references(() => users.id, { onDelete: "cascade" }),
    ownerOrgId: uuid("ownerOrgId").references(() => orgs.id, { onDelete: "cascade" }),
    createdAt,
    updatedAt,
  },
  (t) => [
    check("projects_one_owner_check", sql`(${t.ownerUserId} is null) <> (${t.ownerOrgId} is null)`),
    uniqueIndex("projects_slug_owner_user_unique")
      .on(t.slug, t.ownerUserId)
      .where(sql`${t.ownerOrgId} is null`),
    uniqueIndex("projects_slug_owner_org_unique")
      .on(t.slug, t.ownerOrgId)
      .where(sql`${t.ownerUserId} is null`),
    index("projects_owner_org_idx").on(t.ownerOrgId),
  ],
)

export const userProjectGrant = pgTable(
  "userProjectGrant",
  {
    userId: uuid("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    projectId: uuid("projectId")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    scope: text("scope").notNull(),
    createdAt,
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.projectId] }),
    check("userProjectGrant_scope_check", sql`${t.scope} in ('admin', 'editor', 'viewer')`),
    index("userProjectGrant_projectId_idx").on(t.projectId),
  ],
)

// Rendered into `sessions_activity_idx` and into every query that sorts or filters on activity, so
// the planner always sees the one parse tree the index was built from.
const activityAt = (t: { readonly lastMessageAt: AnyPgColumn; readonly updatedAt: AnyPgColumn }) =>
  sql`coalesce(${t.lastMessageAt}, ${t.updatedAt})`

export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    source: text("source").notNull(),
    userId: uuid("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    projectId: uuid("projectId")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    model: text("model"),
    provider: text("provider"),
    title: text("title"),
    cwd: text("cwd"),
    startCommit: text("startCommit"),
    cliVersion: text("cliVersion"),
    permissionMode: text("permissionMode"),
    startedAt: timestamp("startedAt", { withTimezone: true }),
    lastMessageAt: timestamp("lastMessageAt", { withTimezone: true }),
    createdAt,
    updatedAt,
    searchVector: searchVector("sessions"),
  },
  (t) => [
    index("sessions_projectId_idx").on(t.projectId),
    index("sessions_user_project_updated_idx").on(t.userId, t.projectId, t.updatedAt),
    index("sessions_activity_idx").on(sql`(${activityAt(t)}) desc`, t.id),
  ],
)

export const sessionActivityAt = activityAt(sessions)

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: text("sessionId")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    lineUuid: uuid("lineUuid").notNull(),
    subIndex: integer("subIndex").notNull(),
    parentUuid: text("parentUuid"),
    msgType: text("msgType").notNull(),
    subType: text("subType"),
    role: text("role"),
    timestamp: timestamp("timestamp", { withTimezone: true }),
    lineNumber: integer("lineNumber").notNull(),
    source: text("source").notNull().default("claude_code"),
    sourceRelativePath: text("sourceRelativePath").notNull().default("unknown"),
    trackId: text("trackId").notNull().default("main"),
    model: text("model"),
    provider: text("provider"),
    content: jsonb("content"),
    details: jsonb("details"),
    raw: jsonb("raw").notNull(),
    sourceSchemaVersion: integer("sourceSchemaVersion").notNull(),
    isSubagent: boolean("isSubagent").notNull().default(false),
    agentId: text("agentId"),
    // SET NULL rather than CASCADE: a message belongs to its session, not to a repo. The repo
    // pointer is a decoration, and removing a repo must not remove conversation history.
    repoId: uuid("repoId").references(() => repos.id, { onDelete: "set null" }),
    gitBranch: text("gitBranch"),
    gitCommit: text("gitCommit"),
    createdAt,
    searchVector: searchVector("messages"),
  },
  (t) => [
    unique("messages_line_identity").on(t.sessionId, t.lineUuid, t.subIndex),
    check("messages_msgType_check", sql`${t.msgType} in (${sql.raw(msgTypeValues)})`),
    check(
      "messages_role_check",
      sql`${t.role} is null or ${t.role} in ('user', 'assistant', 'system', 'developer', 'unknown')`,
    ),
    index("messages_session_line_idx").on(t.sessionId, t.lineNumber),
    index("messages_session_agent_idx").on(t.sessionId, t.agentId),
    index("messages_agent_id_idx").on(t.agentId).where(sql`${t.isSubagent}`),
    index("messages_repo_id_idx").on(t.repoId),
  ],
)

/**
 * A commit the session made. `messageId` is SET NULL rather than CASCADE: a commit is a
 * historical fact that outlives the message row it was parsed from.
 */
export const commits = pgTable(
  "commits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repoId: uuid("repoId")
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
    sha: text("sha").notNull(),
    branch: text("branch"),
    subject: text("subject"),
    filesChanged: integer("filesChanged"),
    insertions: integer("insertions"),
    deletions: integer("deletions"),
    sessionId: text("sessionId").references(() => sessions.id, { onDelete: "cascade" }),
    messageId: uuid("messageId").references(() => messages.id, { onDelete: "set null" }),
    createdAt,
  },
  (t) => [
    unique("commits_repo_sha_unique").on(t.repoId, t.sha),
    index("commits_sessionId_idx").on(t.sessionId),
  ],
)

/** A pull request a session opened, keyed by the repo its URL named and its number. */
export const pullRequests = pgTable(
  "pullRequests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repoId: uuid("repoId")
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    // All three exist only in the `gh pr create` command, never in its output, so they are
    // absent for any PR captured before the command was read. Never overwritten with null.
    title: text("title"),
    baseBranch: text("baseBranch"),
    headBranch: text("headBranch"),
    createdAt,
    updatedAt,
    searchVector: searchVector("pullRequests"),
  },
  (t) => [unique("pullRequests_repo_number_unique").on(t.repoId, t.number)],
)

/** Only PRs the session opened are stored, so a row here means "this session created that PR". */
export const sessionPullRequests = pgTable(
  "sessionPullRequests",
  {
    sessionId: text("sessionId")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    prId: uuid("prId")
      .notNull()
      .references(() => pullRequests.id, { onDelete: "cascade" }),
    messageId: uuid("messageId").references(() => messages.id, { onDelete: "set null" }),
    createdAt,
  },
  (t) => [
    primaryKey({ columns: [t.sessionId, t.prId] }),
    index("sessionPullRequests_prId_idx").on(t.prId),
  ],
)

export const toolCall = pgTable(
  "toolCall",
  {
    toolId: text("toolId").notNull(),
    messageId: uuid("messageId")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    toolName: text("toolName").notNull(),
    toolInput: jsonb("toolInput"),
    searchVector: searchVector("toolCall"),
  },
  (t) => [
    primaryKey({ columns: [t.toolId, t.messageId] }),
    index("toolCall_message_idx").on(t.messageId),
    index("toolCall_tool_idx").on(t.toolId),
  ],
)

export const toolResult = pgTable(
  "toolResult",
  {
    toolId: text("toolId").notNull(),
    messageId: uuid("messageId")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    result: jsonb("result"),
    status: text("status").notNull(),
    searchVector: searchVector("toolResult"),
  },
  (t) => [
    primaryKey({ columns: [t.toolId, t.messageId] }),
    check(
      "toolResult_status_check",
      sql`${t.status} in ('success', 'failure', 'cancelled', 'unknown')`,
    ),
    index("toolResult_message_idx").on(t.messageId),
    index("toolResult_tool_idx").on(t.toolId),
  ],
)

export const tokenUsage = pgTable("tokenUsage", {
  messageId: uuid("messageId")
    .primaryKey()
    .references(() => messages.id, { onDelete: "cascade" }),
  inputTokens: integer("inputTokens").notNull().default(0),
  outputTokens: integer("outputTokens").notNull().default(0),
  cachedTokens: integer("cachedTokens").notNull().default(0),
  thinkingTokens: integer("thinkingTokens").notNull().default(0),
})

export const subagents = pgTable(
  "subagents",
  {
    agentId: text("agentId").notNull(),
    sessionId: text("sessionId")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    agentType: text("agentType"),
    description: text("description"),
    spawnDepth: integer("spawnDepth"),
    spawnToolUseId: text("spawnToolUseId"),
    parentAgentId: text("parentAgentId"),
    sourceRelativePath: text("sourceRelativePath").notNull(),
    createdAt,
    updatedAt,
  },
  (t) => [
    primaryKey({ columns: [t.sessionId, t.agentId] }),
    index("subagents_session_id_idx").on(t.sessionId),
    index("subagents_parent_agent_id_idx").on(t.parentAgentId),
  ],
)

/**
 * `relativePath` is stored rather than derived: deriving it needs the session cwd, which lives in
 * transcript content rather than a column. It also survives cwd changes -- the same repo checked
 * out at two paths yields different `path` but identical `relativePath`.
 *
 * No `byteSize` column: `length(currentContent)` is O(1) on bytea and cannot drift out of sync.
 */
export const artifact = pgTable(
  "artifact",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: text("sessionId")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    relativePath: text("relativePath").notNull(),
    mimeType: text("mimeType").notNull(),
    isBinary: boolean("isBinary").notNull(),
    baseContent: bytea("baseContent"),
    baseHash: text("baseHash"),
    currentContent: bytea("currentContent").notNull(),
    currentHash: text("currentHash").notNull(),
    diff: text("diff"),
    oldFragment: text("oldFragment"),
    changeKind: text("changeKind").notNull(),
    editCount: integer("editCount").notNull().default(1),
    firstSeenAt: timestamp("firstSeenAt", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("lastSeenAt", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("artifact_session_path_uniq").on(t.sessionId, t.path),
    index("artifact_session_idx").on(t.sessionId),
    index("artifact_relpath_idx").on(t.relativePath),
    check(
      "artifact_changeKind_check",
      sql`${t.changeKind} in ('created', 'edited', 'editedUnknownBase')`,
    ),
  ],
)
