import { getJson } from "./client.js"
import { parseSessionArtifacts } from "./parse.js"
import type { ApiResult, CapturedArtifact } from "./types.js"

export const fetchSessionArtifacts = (
  sessionId: string,
): Promise<ApiResult<ReadonlyArray<CapturedArtifact>>> =>
  getJson(`/api/sessions/${encodeURIComponent(sessionId)}/artifacts`, parseSessionArtifacts)

export const rawArtifactUrl = (artifactId: string, which: "base" | "current" = "current"): string =>
  `/api/artifacts/${encodeURIComponent(artifactId)}/raw?which=${which}`
