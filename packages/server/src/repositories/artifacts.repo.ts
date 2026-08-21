import { createHash } from "node:crypto"
import { and, asc, eq, sql } from "drizzle-orm"
import type { Querier } from "../db/client.js"
import { artifact, projects, sessions } from "../db/schema.js"
import { visibleToUser } from "./projects.repo.js"

export type UpsertArtifactInput = {
  readonly sessionId: string
  readonly path: string
  readonly relativePath: string
  readonly mimeType: string
  readonly isBinary: boolean
  readonly changeKind: string
  readonly currentContent: Buffer
  readonly currentHash: string
  readonly baseContent?: Buffer
  readonly diff?: string
  readonly oldFragment?: string
}

export type UpsertArtifactResult = {
  readonly artifactId: string
  readonly updated: boolean
}

/**
 * The base coalesces existing-first, so an incoming base can never displace a stored one. A later
 * upload carrying a base -- after a daemon restart, or a lost `artifacts.json` -- would be carrying
 * post-edit content re-derived as a "base"; because base is frozen on write, accepting it would
 * make every future diff for that file permanently wrong.
 *
 * Identifiers are written table-qualified inside the template: drizzle only auto-qualifies column
 * references inside its builder methods, never inside a raw `sql` fragment.
 */
const set = {
  baseContent: sql`coalesce("artifact"."baseContent", excluded."baseContent")`,
  // The content and its server-derived digest must be repaired together for legacy rows whose
  // nullable client hash was absent or incorrect. Existing valid bases remain immutable.
  baseHash: sql`case
    when "artifact"."baseContent" is null then excluded."baseHash"
    when "artifact"."baseHash" is null or "artifact"."baseHash" <> encode(sha256("artifact"."baseContent"), 'hex')
      then encode(sha256("artifact"."baseContent"), 'hex')
    else "artifact"."baseHash"
  end`,
  baseHashVerified: sql`case
    when "artifact"."baseContent" is null then excluded."baseHashVerified"
    else true
  end`,
  currentContent: sql`excluded."currentContent"`,
  currentHash: sql`excluded."currentHash"`,
  mimeType: sql`excluded."mimeType"`,
  isBinary: sql`excluded."isBinary"`,
  relativePath: sql`excluded."relativePath"`,
  diff: sql`excluded."diff"`,
  oldFragment: sql`excluded."oldFragment"`,
  changeKind: sql`excluded."changeKind"`,
  editCount: sql`"artifact"."editCount" + 1`,
  lastSeenAt: sql`now()`,
}

const sha256 = (content: Buffer): string => createHash("sha256").update(content).digest("hex")

export const upsertArtifact = async (
  db: Querier,
  input: UpsertArtifactInput,
): Promise<UpsertArtifactResult> => {
  const [row] = await db
    .insert(artifact)
    .values({
      sessionId: input.sessionId,
      path: input.path,
      relativePath: input.relativePath,
      mimeType: input.mimeType,
      isBinary: input.isBinary,
      changeKind: input.changeKind,
      currentContent: input.currentContent,
      currentHash: input.currentHash,
      baseContent: input.baseContent ?? null,
      baseHash: input.baseContent === undefined ? null : sha256(input.baseContent),
      baseHashVerified: input.baseContent !== undefined,
      diff: input.diff ?? null,
      oldFragment: input.oldFragment ?? null,
    })
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
  readonly hasBase: boolean
  readonly hasDiff: boolean
  readonly hasOldFragment: boolean
  readonly diffByteSize: number | null
  readonly oldFragmentByteSize: number | null
  readonly firstSeenAt: string
  readonly lastSeenAt: string
}

export type ArtifactDetailPart = "diff" | "oldFragment"

export type ArtifactDetailRow = ArtifactSummaryRow & {
  readonly sessionId: string
  readonly diff: string | null
  readonly oldFragment: string | null
}

export type ArtifactSide = "base" | "current"

export type ArtifactByteMetadata = {
  readonly byteSize: number | null
  readonly isBinary: boolean
  readonly mimeType: string
  readonly hash: string | null
  /** A bounded signature sample for MIME hardening; this is never an artifact body. */
  readonly sample: Buffer | null
}

export type ArtifactBytes = {
  readonly bytes: Buffer
}

export type ArtifactByteSlice = {
  /** Zero-based offset, converted to PostgreSQL's one-based substring offset in the query. */
  readonly start: number
  readonly length: number
}

/**
 * Visibility is a join condition rather than a post-filter, so an artifact the caller cannot see
 * never leaves Postgres. Every caller collapses "no such row" and "not yours" into `null`: the
 * routes cannot then leak existence through a 403-vs-404 difference.
 *
 * This intentionally has no body columns. List and detail routes build their own projections below
 * so adding a field here cannot accidentally make every artifact list carry a diff or fragment.
 */
const artifactMetadataProjection = {
  id: artifact.id,
  sessionId: artifact.sessionId,
  path: artifact.path,
  relativePath: artifact.relativePath,
  mimeType: artifact.mimeType,
  isBinary: artifact.isBinary,
  changeKind: artifact.changeKind,
  editCount: artifact.editCount,
  byteSize: sql<number>`octet_length("artifact"."currentContent")::int`,
  hasBase: sql<boolean>`("artifact"."baseContent" is not null)`,
  hasDiff: sql<boolean>`("artifact"."diff" is not null)`,
  hasOldFragment: sql<boolean>`("artifact"."oldFragment" is not null)`,
  diffByteSize: sql<number | null>`octet_length("artifact"."diff")::int`,
  oldFragmentByteSize: sql<number | null>`octet_length("artifact"."oldFragment")::int`,
  firstSeenAt: sql<string>`${artifact.firstSeenAt}`,
  lastSeenAt: sql<string>`${artifact.lastSeenAt}`,
}

const visibleArtifactMetadata = (db: Querier, userId: string, where: ReturnType<typeof and>) =>
  db
    .select(artifactMetadataProjection)
    .from(artifact)
    .innerJoin(sessions, eq(sessions.id, artifact.sessionId))
    .innerJoin(projects, eq(projects.id, sessions.projectId))
    .where(and(where, visibleToUser(db, userId)))

/**
 * `currentContent`, `baseContent`, `diff`, and `oldFragment` are deliberately absent: list bytes
 * remain bounded as individual artifact bodies grow.
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

  const rows = await visibleArtifactMetadata(db, userId, eq(artifact.sessionId, sessionId)).orderBy(
    asc(artifact.relativePath),
  )
  return rows.map(({ sessionId: _sessionId, ...summary }) => summary)
}

/**
 * Detail bodies are opt-in and mutually exclusive. Opening Diff or the replaced excerpt therefore
 * reads exactly one text column; the base/current bytes remain available only from the raw side
 * endpoint, which likewise projects one side at a time.
 */
export const getArtifact = async (
  db: Querier,
  userId: string,
  artifactId: string,
  part: ArtifactDetailPart | undefined,
): Promise<ArtifactDetailRow | null> => {
  if (!UUID.test(artifactId)) return null

  const body =
    part === "diff"
      ? { diff: artifact.diff, oldFragment: sql<null>`null` }
      : part === "oldFragment"
        ? { diff: sql<null>`null`, oldFragment: artifact.oldFragment }
        : { diff: sql<null>`null`, oldFragment: sql<null>`null` }

  const [row] = await db
    .select({ ...artifactMetadataProjection, ...body })
    .from(artifact)
    .innerJoin(sessions, eq(sessions.id, artifact.sessionId))
    .innerJoin(projects, eq(projects.id, sessions.projectId))
    .where(and(eq(artifact.id, artifactId), visibleToUser(db, userId)))
    .limit(1)
  return row ?? null
}

const sideColumn = (which: ArtifactSide) =>
  which === "base" ? artifact.baseContent : artifact.currentContent
const sideHash = (which: ArtifactSide) =>
  which === "base" ? artifact.baseHash : artifact.currentHash

const byteMetadataProjection = (which: ArtifactSide) => {
  const content = sideColumn(which)
  return {
    byteSize: sql<number | null>`octet_length(${content})::int`,
    isBinary: artifact.isBinary,
    mimeType: artifact.mimeType,
    hash: sideHash(which),
    baseHashVerified: artifact.baseHashVerified,
    // Enough bytes for every signature inspected by serveHeadersFor, without pulling the body.
    sample: sql<Buffer | null>`substring(${content} from 1 for 512)`,
  }
}

const byteMetadataFor = async (
  db: Querier,
  userId: string,
  where: ReturnType<typeof and>,
  which: ArtifactSide,
): Promise<ArtifactByteMetadata | null> => {
  const [row] = await db
    .select(byteMetadataProjection(which))
    .from(artifact)
    .innerJoin(sessions, eq(sessions.id, artifact.sessionId))
    .innerJoin(projects, eq(projects.id, sessions.projectId))
    .where(and(where, visibleToUser(db, userId)))
    .limit(1)
  if (!row) return null

  // New rows get their hash during upsert. The marker makes existing rows self-heal only when their
  // base is actually read, avoiding an unbounded full-blob migration. Do not trust the old nullable
  // client hash even when it happens to be present.
  if (which === "base" && row.byteSize !== null && !row.baseHashVerified) {
    const [repaired] = await db
      .update(artifact)
      .set({
        baseHash: sql`encode(sha256("baseContent"), 'hex')`,
        baseHashVerified: true,
      })
      .where(and(where, eq(artifact.baseHashVerified, false)))
      .returning({ hash: artifact.baseHash })
    return repaired ? { ...row, hash: repaired.hash } : byteMetadataFor(db, userId, where, which)
  }
  return row
}

export const getArtifactByteMetadata = (
  db: Querier,
  userId: string,
  artifactId: string,
  which: ArtifactSide,
): Promise<ArtifactByteMetadata | null> =>
  UUID.test(artifactId)
    ? byteMetadataFor(db, userId, eq(artifact.id, artifactId), which)
    : Promise.resolve(null)

export const getArtifactByteMetadataByPath = (
  db: Querier,
  userId: string,
  sessionId: string,
  relativePath: string,
  which: ArtifactSide,
): Promise<ArtifactByteMetadata | null> =>
  byteMetadataFor(
    db,
    userId,
    and(eq(artifact.sessionId, sessionId), eq(artifact.relativePath, relativePath)),
    which,
  )

const bytesFor = async (
  db: Querier,
  userId: string,
  where: ReturnType<typeof and>,
  which: ArtifactSide,
  slice: ArtifactByteSlice | undefined,
): Promise<ArtifactBytes | null> => {
  const content = sideColumn(which)
  const selected =
    slice === undefined
      ? content
      : sql<Buffer | null>`substring(${content} from ${slice.start + 1} for ${slice.length})`
  const [row] = await db
    .select({ bytes: selected })
    .from(artifact)
    .innerJoin(sessions, eq(sessions.id, artifact.sessionId))
    .innerJoin(projects, eq(projects.id, sessions.projectId))
    .where(and(where, visibleToUser(db, userId)))
    .limit(1)
  if (!row?.bytes) return null
  return { bytes: row.bytes }
}

export const getArtifactBytes = (
  db: Querier,
  userId: string,
  artifactId: string,
  which: ArtifactSide,
  slice?: ArtifactByteSlice,
): Promise<ArtifactBytes | null> =>
  UUID.test(artifactId)
    ? bytesFor(db, userId, eq(artifact.id, artifactId), which, slice)
    : Promise.resolve(null)

/**
 * The same bytes, addressed the way a captured document addresses its own siblings. A report links
 * `screenshots/01.png`, not a uuid, so serving it from a path-shaped URL is what lets the browser
 * resolve those references against the document rather than requiring the html be rewritten.
 */
export const getArtifactBytesByPath = (
  db: Querier,
  userId: string,
  sessionId: string,
  relativePath: string,
  which: ArtifactSide,
  slice?: ArtifactByteSlice,
): Promise<ArtifactBytes | null> =>
  bytesFor(
    db,
    userId,
    and(eq(artifact.sessionId, sessionId), eq(artifact.relativePath, relativePath)),
    which,
    slice,
  )
