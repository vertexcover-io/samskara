import { Navigate, useSearchParams } from "react-router-dom"
import { tabPath } from "../project/ProjectTabs.js"

/**
 * The old Fixes page's address. Fixes now live on each project's page, so `/learnings?project=X`
 * lands on X's Fixes tab with the rest of its query kept; with no project, on the projects list.
 */
export const LearningsRedirect = () => {
  const [searchParams] = useSearchParams()
  const project = searchParams.get("project")
  if (project === null || project === "") return <Navigate to="/projects" replace />
  const kept = new URLSearchParams(searchParams)
  kept.delete("project")
  const query = kept.toString()
  return <Navigate to={`${tabPath(project, "fixes")}${query === "" ? "" : `?${query}`}`} replace />
}
