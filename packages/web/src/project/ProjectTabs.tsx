import { Link } from "react-router-dom"

export type ProjectTab = "overview" | "fixes" | "runs" | "settings"

/** The project page's tabs, in order. Each is a path under the project, so a reload or a shared link lands on it. */
export const PROJECT_TABS: ReadonlyArray<{ readonly id: ProjectTab; readonly label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "fixes", label: "Fixes" },
]

/** Where a tab lives: Overview is the project's own path, every other tab a segment under it. */
export const tabPath = (projectId: string, tab: ProjectTab): string =>
  `/projects/${encodeURIComponent(projectId)}${tab === "overview" ? "" : `/${tab}`}`

/** The tab, and the run when the path names one, from the part of the URL after `/projects/:id`. */
export type ProjectView = { readonly tab: ProjectTab; readonly runId: string | null }

/** Null for a path no tab owns, so the page can send the reader to Overview instead. */
export const parseProjectPath = (rest: string): ProjectView | null => {
  const [first = "", second, ...more] = rest.split("/").filter((part) => part !== "")
  if (first === "") return { tab: "overview", runId: null }
  const tab = PROJECT_TABS.find((t) => t.id === first && t.id !== "overview")
  if (tab === undefined || more.length > 0) return null
  if (second === undefined) return { tab: tab.id, runId: null }
  return tab.id === "runs" ? { tab: "runs", runId: decodeURIComponent(second) } : null
}

export const ProjectTabs = ({
  projectId,
  selected,
}: {
  readonly projectId: string
  readonly selected: ProjectTab
}) => (
  <nav aria-label="Project" className="mt-5 flex gap-5 overflow-x-auto border-b border-rule">
    {PROJECT_TABS.map((tab) => (
      <Link
        key={tab.id}
        to={tabPath(projectId, tab.id)}
        aria-current={tab.id === selected ? "page" : undefined}
        className={`-mb-px shrink-0 border-b-2 py-2 text-[0.8125rem] font-semibold transition-colors ${
          tab.id === selected
            ? "border-stamp text-ink"
            : "border-transparent text-ink-soft hover:text-ink"
        }`}
      >
        {tab.label}
      </Link>
    ))}
  </nav>
)
