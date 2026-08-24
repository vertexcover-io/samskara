import { type ApiResult, client, request } from "./client.js"
import type { CapturedArtifact } from "./types.js"

export const fetchSessionArtifacts = (
  sessionId: string,
): Promise<ApiResult<ReadonlyArray<CapturedArtifact>>> =>
  request(() => client.api.sessions[":id"].artifacts.$get({ param: { id: sessionId } })).then(
    (result) => (result.ok ? { ok: true, data: result.data.artifacts } : result),
  )

export const rawArtifactUrl = (artifactId: string, which: "base" | "current" = "current"): string =>
  `/api/artifacts/${encodeURIComponent(artifactId)}/raw?which=${which}`

/**
 * Addressed by the path the artifact had on disk, so a rendered document resolves the siblings it
 * references against its own URL. Each segment is encoded separately -- encoding the whole path
 * would escape the separators and address one file whose name contains slashes.
 */
export const artifactPathUrl = (sessionId: string, relativePath: string): string => {
  const path = relativePath.split("/").map(encodeURIComponent).join("/")
  return `/api/artifacts/session/${encodeURIComponent(sessionId)}/files/${path}`
}
