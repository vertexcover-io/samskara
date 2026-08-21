import type { SessionRepo } from "./shapes.js"

/**
 * A remoteless repo is keyed by its absolute root path, so only its name is worth showing --
 * `owner/name` would read as `/Users/maya/Projects/samskara/samskara`.
 */
export const repoLabel = (repo: SessionRepo): string =>
  repo.host === "local" ? repo.repoName : `${repo.owner}/${repo.repoName}`

/** Null for a remoteless repo: its `owner` is a path on one machine, not an address. */
export const repoUrl = (repo: SessionRepo): string | null =>
  repo.host === "local" ? null : `https://${repo.host}/${repo.owner}/${repo.repoName}`
