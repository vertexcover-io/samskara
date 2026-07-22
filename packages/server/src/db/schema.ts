import { sql } from "drizzle-orm"
import {
  bigint,
  boolean,
  check,
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

const createdAt = timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
const updatedAt = timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()

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

export const userRepos = pgTable(
  "user_repos",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    repoId: uuid("repo_id")
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
    createdAt,
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.repoId] }),
    index("user_repos_repo_id_idx").on(t.repoId),
  ],
)

export const orgRepos = pgTable(
  "org_repos",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    repoId: uuid("repo_id")
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
    createdAt,
  },
  (t) => [
    primaryKey({ columns: [t.orgId, t.repoId] }),
    index("org_repos_repo_id_idx").on(t.repoId),
  ],
)

export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  repoId: uuid("repo_id")
    .notNull()
    .references(() => repos.id, { onDelete: "cascade" }),
  gitBranch: text("git_branch"),
  gitCommit: text("git_commit"),
  cliVersion: text("cli_version"),
  permissionMode: text("permission_mode"),
  firstEventAt: timestamp("first_event_at", { withTimezone: true }),
  lastEventAt: timestamp("last_event_at", { withTimezone: true }),
  messageCount: integer("message_count").notNull().default(0),
  createdAt,
  updatedAt,
})

export const messages = pgTable(
  "messages",
  {
    uuid: text("uuid").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    parentUuid: text("parent_uuid"),
    type: text("type").notNull(),
    role: text("role"),
    timestamp: timestamp("timestamp", { withTimezone: true }),
    lineNumber: integer("line_number").notNull(),
    sourceRelativePath: text("source_relative_path").notNull(),
    sourceSchemaVersion: integer("source_schema_version").notNull(),
    model: text("model"),
    provider: text("provider"),
    content: text("content"),
    thinking: text("thinking"),
    toolUseId: text("tool_use_id"),
    isSubagent: boolean("is_subagent").notNull().default(false),
    agentId: text("agent_id"),
    raw: jsonb("raw").notNull(),
    createdAt,
  },
  (t) => [
    check("messages_type_check", sql`${t.type} in ('user', 'assistant', 'system', 'attachment')`),
    index("messages_session_line_idx").on(t.sessionId, t.lineNumber),
    index("messages_session_agent_idx").on(t.sessionId, t.agentId),
    index("messages_agent_id_idx").on(t.agentId).where(sql`${t.isSubagent}`),
    index("messages_tool_use_id_idx").on(t.toolUseId),
  ],
)

export const subagents = pgTable(
  "subagents",
  {
    agentId: text("agent_id").notNull(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    agentType: text("agent_type"),
    description: text("description"),
    spawnDepth: integer("spawn_depth"),
    spawnToolUseId: text("spawn_tool_use_id"),
    parentAgentId: text("parent_agent_id"),
    sourceRelativePath: text("source_relative_path").notNull(),
    firstEventAt: timestamp("first_event_at", { withTimezone: true }),
    lastEventAt: timestamp("last_event_at", { withTimezone: true }),
    messageCount: integer("message_count").notNull().default(0),
    createdAt,
    updatedAt,
  },
  (t) => [
    primaryKey({ columns: [t.sessionId, t.agentId] }),
    index("subagents_session_id_idx").on(t.sessionId),
    index("subagents_parent_agent_id_idx").on(t.parentAgentId),
  ],
)

export const tokenUsage = pgTable("token_usage", {
  messageUuid: text("message_uuid")
    .primaryKey()
    .references(() => messages.uuid, { onDelete: "cascade" }),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  cachedTokens: integer("cached_tokens").notNull().default(0),
  thinkingTokens: integer("thinking_tokens").notNull().default(0),
})
