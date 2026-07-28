import { MSG_TYPES } from "@samskara/core"
import { sql } from "drizzle-orm"
import {
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

const msgTypeValues = MSG_TYPES.map((t) => `'${t}'`).join(", ")

const createdAt = timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
const updatedAt = timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()

const createdAtCamel = timestamp("createdAt", { withTimezone: true }).notNull().defaultNow()
const updatedAtCamel = timestamp("updatedAt", { withTimezone: true }).notNull().defaultNow()

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  githubId: bigint("github_id", { mode: "number" }).notNull().unique(),
  githubLogin: text("github_login").notNull(),
  email: text("email"),
  name: text("name"),
  avatarUrl: text("avatar_url"),
  createdAt,
  updatedAt,
})

export const orgs = pgTable("orgs", {
  id: uuid("id").primaryKey().defaultRandom(),
  githubOrgId: bigint("github_org_id", { mode: "number" }).unique(),
  githubSlug: text("github_slug").notNull().unique(),
  name: text("name"),
  createdAt,
  updatedAt,
})

export const repos = pgTable(
  "repos",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    host: text("host").notNull(),
    owner: text("owner").notNull(),
    ownerType: text("owner_type").notNull(),
    repoName: text("repo_name").notNull(),
    createdAt,
    updatedAt,
  },
  (t) => [
    unique("repos_identity_unique").on(t.host, t.owner, t.ownerType, t.repoName),
    check("repos_owner_type_check", sql`${t.ownerType} in ('user', 'org')`),
  ],
)

export const userOrgs = pgTable(
  "user_orgs",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    createdAt,
  },
  (t) => [primaryKey({ columns: [t.userId, t.orgId] }), index("user_orgs_org_id_idx").on(t.orgId)],
)

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    ownerId: uuid("ownerId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: createdAtCamel,
    updatedAt: updatedAtCamel,
  },
  (t) => [unique("projects_slug_owner_unique").on(t.slug, t.ownerId)],
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
    createdAt: createdAtCamel,
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.projectId] }),
    check("userProjectGrant_scope_check", sql`${t.scope} in ('admin', 'editor', 'viewer')`),
    index("userProjectGrant_projectId_idx").on(t.projectId),
  ],
)

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
    createdAt: createdAtCamel,
    updatedAt: updatedAtCamel,
  },
  (t) => [index("sessions_projectId_idx").on(t.projectId)],
)

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
    repoId: uuid("repoId").references(() => repos.id),
    gitBranch: text("gitBranch"),
    gitCommit: text("gitCommit"),
    createdAt: createdAtCamel,
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
    createdAt: createdAtCamel,
  },
  (t) => [
    unique("commits_repo_sha_unique").on(t.repoId, t.sha),
    index("commits_sessionId_idx").on(t.sessionId),
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
    createdAt: createdAtCamel,
    updatedAt: updatedAtCamel,
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
