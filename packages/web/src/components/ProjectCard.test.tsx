import { render, screen, within } from "@testing-library/react"
import { expect, test } from "vitest"
import type { ProjectSummary } from "../api/types.js"
import { TestRouter } from "../tests/test-router.js"
import { ProjectCard } from "./ProjectCard.js"

const fullProject: ProjectSummary = {
  id: "p-1",
  name: "Samskara",
  slug: "samskara",
  owner: { type: "user", slug: "ritesh" },
  sessionCount: 12,
  lastActiveAt: "2026-02-01T09:30:00.000Z",
  repo: null,
}

const renderCard = (project: ProjectSummary = fullProject) =>
  render(
    <TestRouter initialEntries={["/projects"]}>
      <ProjectCard project={project} to={`/projects/${project.id}`} />
    </TestRouter>,
  )

test("S2: a fully-populated card renders name, slug, session count, and last-active time - all four, inside the card itself", () => {
  renderCard()

  const card = within(screen.getByRole("article"))
  expect(card.getByText("Samskara")).toBeInTheDocument()
  expect(card.getByText(/samskara/)).toBeInTheDocument()
  expect(card.getByText("12")).toBeInTheDocument()
  expect(card.getByText(/2026/)).toBeInTheDocument()
})

test("S2: the card offers the project and its sessions as separate destinations", () => {
  renderCard()

  expect(screen.getByRole("link", { name: "Samskara" })).toHaveAttribute("href", "/projects/p-1")
  expect(screen.getByRole("link", { name: /view 12 sessions/i })).toHaveAttribute(
    "href",
    "/sessions?project=p-1",
  )
})

test("S3: a project with nothing captured says so instead of offering an empty session list", () => {
  renderCard({ ...fullProject, sessionCount: 0, lastActiveAt: null })

  const status = screen.getByRole("status")
  expect(status).toHaveTextContent(/no sessions captured yet/i)
  expect(screen.queryByRole("link", { name: /view .* sessions/i })).not.toBeInTheDocument()
})

test("S3: an unavailable last-active field renders the word 'unavailable' rather than an empty cell coloured differently", () => {
  renderCard({ ...fullProject, lastActiveAt: null })

  expect(screen.getByText("unavailable")).toBeInTheDocument()
})

test("SC31: an org-owned project's card links to the owning org", () => {
  renderCard({ ...fullProject, owner: { type: "org", slug: "acme" } })

  expect(screen.getByRole("link", { name: /org · acme/i })).toHaveAttribute("href", "/orgs/acme")
})

test("SC31: a personal project's card says the project is yours, without naming you", () => {
  renderCard({ ...fullProject, owner: { type: "user", slug: "ritesh" } })

  const card = within(screen.getByRole("article"))
  expect(card.getByText("yours")).toBeInTheDocument()
  expect(card.queryByText(/ritesh/)).not.toBeInTheDocument()
  expect(screen.queryByRole("link", { name: /^org · /i })).not.toBeInTheDocument()
})
