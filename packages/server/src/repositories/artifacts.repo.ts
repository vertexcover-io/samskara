import { and, asc, eq, sql } from "drizzle-orm"
import type { Querier } from "../db/client.js"
import { artifact, projects, sessions } from "../db/schema.js"
import { visibleToUser } from "./projects.repo.js"

/** Withheld for a binary artifact in SQL, not after: it renders no diff and a base can be 50MB. */
export const findArtifactBase = async (
  db: Querier,
  sessionId: string,
  path: string,
): Promise<{ readonly baseContent: Buffer | null } | undefined> => {
  const [row] = await db
    .select({
      baseContent: sql<Buffer | null>`case when "artifact"."isBinary" then null else "artifact"."baseContent" end`,
    })
    .from(artifact)
    .where(and(eq(artifact.sessionId, sessionId), eq(artifact.path, path)))

  return row
}

export type UpsertArtifactInput = {
  readonly sessionId: string
  readonly path: string
  readonly relativePath: string
  readonly mimeType: string
  readonly isBinary: boolean
  readonly changeKind: string
  readonly currentContent: Buffer
  readonly currentHash: string
  readonly baseContent: Buffer | null
  readonly diff: string | null
}

/**
 * `baseContent` and `changeKind` are absent on purpose: a column left out of `ON CONFLICT DO
 * UPDATE` keeps its stored value, so only the first upload for a path decides them.
 */
const set = {
  currentContent: sql`excluded."currentContent"`,
  currentHash: sql`excluded."currentHash"`,
  mimeType: sql`excluded."mimeType"`,
  isBinary: sql`excluded."isBinary"`,
  relativePath: sql`excluded."relativePath"`,
  diff: sql`excluded."diff"`,
  editCount: sql`"artifact"."editCount" + 1`,
  lastSeenAt: sql`now()`,
}

export const upsertArtifact = async (
  db: Querier,
  input: UpsertArtifactInput,
): Promise<{ readonly artifactId: string; readonly updated: boolean }> => {
  const [row] = await db
    .insert(artifact)
    .values(input)
    .onConflictDoUpdate({ target: [artifact.sessionId, artifact.path], set })
    .returning({ id: artifact.id, editCount: artifact.editCount })

  if (!row) throw new Error("artifact upsert returned no row")
  return { artifactId: row.id, updated: row.editCount > 1 }
}

/**
 * `artifact.id` is a uuid column, so an id Postgres cannot cast raises rather than missing. Failing
 * the same `null` as an invisible row keeps the routes' 404 indistinct instead of leaking a 500.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type ArtifactSummaryRow = {
  readonly id: string
  readonly path: string
  readonly relativePath: string
  readonly mimeType: string
  readonly isBinary: boolean
  readonly changeKind: string
  readonly editCount: number
  readonly byteSize: number
  readonly diff: string | null
  readonly hasBase: boolean
  readonly firstSeenAt: string
  readonly lastSeenAt: string
}

export type ArtifactDetailRow = ArtifactSummaryRow & {
  readonly sessionId: string
  readonly currentContent: string | null
  readonly baseContent: string | null
}

export type ArtifactSide = "base" | "current"

export type ArtifactBytes = {
  readonly bytes: Buffer
  readonly isBinary: boolean
  readonly mimeType: string
}

/**
 * Visibility is a join condition rather than a post-filter, so an artifact the caller cannot see
 * never leaves Postgres. Every caller collapses "no such row" and "not yours" into `null`: the
 * routes cannot then leak existence through a 403-vs-404 difference.
 */
const visibleArtifact = (db: Querier, userId: string, where: ReturnType<typeof eq>) =>
  db
    .select({
      id: artifact.id,
      sessionId: artifact.sessionId,
      path: artifact.path,
      relativePath: artifact.relativePath,
      mimeType: artifact.mimeType,
      isBinary: artifact.isBinary,
      changeKind: artifact.changeKind,
      editCount: artifact.editCount,
      byteSize: sql<number>`length("artifact"."currentContent")::int`,
      diff: artifact.diff,
      hasBase: sql<boolean>`("artifact"."baseContent" is not null)`,
      firstSeenAt: sql<string>`${artifact.firstSeenAt}`,
      lastSeenAt: sql<string>`${artifact.lastSeenAt}`,
    })
    .from(artifact)
    .innerJoin(sessions, eq(sessions.id, artifact.sessionId))
    .innerJoin(projects, eq(projects.id, sessions.projectId))
    .where(and(where, visibleToUser(db, userId)))

/**
 * `currentContent` is deliberately absent: selecting it here would pull every artifact's full bytes
 * for a list view. `byteSize` gives the UI a size without a second query.
 */
export const listForSession = async (
  db: Querier,
  userId: string,
  sessionId: string,
): Promise<ReadonlyArray<ArtifactSummaryRow> | null> => {
  const [session] = await db
    .select({ id: sessions.id })
    .from(sessions)
    .innerJoin(projects, eq(projects.id, sessions.projectId))
    .where(and(eq(sessions.id, sessionId), visibleToUser(db, userId)))
  if (!session) return null

  const rows = await visibleArtifact(db, userId, eq(artifact.sessionId, sessionId)).orderBy(
    asc(artifact.relativePath),
  )
  return rows.map(({ sessionId: _sessionId, ...summary }) => summary)
}

/**
 * A binary artifact returns its metadata with both contents omitted -- the caller uses `/raw` for
 * bytes. Text is decoded here rather than streamed because the detail view renders it.
 */
export const getArtifact = async (
  db: Querier,
  userId: string,
  artifactId: string,
): Promise<ArtifactDetailRow | null> => {
  if (!UUID.test(artifactId)) return null

  const [row] = await visibleArtifact(db, userId, eq(artifact.id, artifactId)).limit(1)
  if (!row) return null

  if (row.isBinary) return { ...row, currentContent: null, baseContent: null }

  const [contents] = await db
    .select({ currentContent: artifact.currentContent, baseContent: artifact.baseContent })
    .from(artifact)
    .where(eq(artifact.id, artifactId))

  return {
    ...row,
    currentContent: contents?.currentContent?.toString("utf8") ?? null,
    baseContent: contents?.baseContent?.toString("utf8") ?? null,
  }
}

export const getArtifactBytes = async (
  db: Querier,
  userId: string,
  artifactId: string,
  which: ArtifactSide,
): Promise<ArtifactBytes | null> => {
  if (!UUID.test(artifactId)) return null

  const [row] = await db
    .select({
      baseContent: artifact.baseContent,
      currentContent: artifact.currentContent,
      isBinary: artifact.isBinary,
      mimeType: artifact.mimeType,
    })
    .from(artifact)
    .innerJoin(sessions, eq(sessions.id, artifact.sessionId))
    .innerJoin(projects, eq(projects.id, sessions.projectId))
    .where(and(eq(artifact.id, artifactId), visibleToUser(db, userId)))
    .limit(1)
  if (!row) return null

  const bytes = which === "base" ? row.baseContent : row.currentContent
  if (!bytes) return null

  return { bytes, isBinary: row.isBinary, mimeType: row.mimeType }
}

/**
 * The same bytes, addressed the way a captured document addresses its own siblings. A report links
 * `screenshots/01.png`, not a uuid, so serving it from a path-shaped URL is what lets the browser
 * resolve those references against the document rather than requiring the html be rewritten.
 *
 * `relativePath` is unique within a session -- one session belongs to one project and every path is
 * made relative to that single root -- so this matches at most one row without a tie-break.
 *
 * There is no filesystem here: a `..` segment cannot traverse anywhere, it simply fails to equal a
 * captured path. Visibility is the same join the uuid route uses.
 */
export const getArtifactBytesByPath = async (
  db: Querier,
  userId: string,
  sessionId: string,
  relativePath: string,
  which: ArtifactSide,
): Promise<ArtifactBytes | null> => {
  const [row] = await db
    .select({
      baseContent: artifact.baseContent,
      currentContent: artifact.currentContent,
      isBinary: artifact.isBinary,
      mimeType: artifact.mimeType,
    })
    .from(artifact)
    .innerJoin(sessions, eq(sessions.id, artifact.sessionId))
    .innerJoin(projects, eq(projects.id, sessions.projectId))
    .where(
      and(
        eq(artifact.sessionId, sessionId),
        eq(artifact.relativePath, relativePath),
        visibleToUser(db, userId),
      ),
    )
    .limit(1)
  if (!row) return null

  const bytes = which === "base" ? row.baseContent : row.currentContent
  if (!bytes) return null

  return { bytes, isBinary: row.isBinary, mimeType: row.mimeType }
}
