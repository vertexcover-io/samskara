import { getJson } from "./client.js"
import { parseSessionArtifacts } from "./parse.js"
import type { ApiResult, CapturedArtifact } from "./types.js"

export const fetchSessionArtifacts = (
  sessionId: string,
): Promise<ApiResult<ReadonlyArray<CapturedArtifact>>> =>
  getJson(`/api/sessions/${encodeURIComponent(sessionId)}/artifacts`, parseSessionArtifacts)

export type ArtifactDetailPart = "diff" | "oldFragment"

/** The selected artifact body is fetched only when its view becomes active. */
export const artifactDetailUrl = (artifactId: string, part: ArtifactDetailPart): string =>
  `/api/artifacts/${encodeURIComponent(artifactId)}?part=${part}`

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
