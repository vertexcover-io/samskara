import { repoLabel, repoUrl } from "../api/repo.js"
import type { SessionRepo } from "../api/types.js"

/** Opens in a new tab: a repo link leaves the app entirely. A remoteless repo has no address, so
 * it renders as plain text. */
export const RepoLink = ({ repo }: { repo: SessionRepo }) => {
  const url = repoUrl(repo)
  const label = repoLabel(repo)
  if (url === null) return <span>{label}</span>
  return (
    <a href={url} target="_blank" rel="noreferrer" className="text-custody hover:underline">
      {label}
    </a>
  )
}
