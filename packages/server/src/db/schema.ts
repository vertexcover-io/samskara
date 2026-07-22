import { sql } from "drizzle-orm"
import {
  bigint,
  check,
  index,
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
