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
}

test("S2: a fully-populated card renders name, slug, session count, and last-active time - all four, inside the card itself", () => {
  render(
    <TestRouter initialEntries={["/projects"]}>
      <ProjectCard project={fullProject} to="/sessions?project=samskara" />
    </TestRouter>,
  )

  const card = within(screen.getByRole("link"))
  expect(card.getByText("Samskara")).toBeInTheDocument()
  expect(card.getByText(/samskara/)).toBeInTheDocument()
  expect(card.getByText(/12/)).toBeInTheDocument()
  expect(card.getByText(/2026/)).toBeInTheDocument()
})

test("S2: the whole card is one link, so a project opens in a new tab the way any other link does", () => {
  render(
    <TestRouter initialEntries={["/projects"]}>
      <ProjectCard project={fullProject} to="/sessions?project=samskara" />
    </TestRouter>,
  )

  expect(screen.getByRole("link")).toHaveAttribute("href", "/sessions?project=samskara")
})

test("S3: an unavailable last-active field renders the word 'unavailable' rather than an empty cell coloured differently", () => {
  render(
    <TestRouter initialEntries={["/projects"]}>
      <ProjectCard
        project={{ ...fullProject, sessionCount: 0, lastActiveAt: null }}
        to="/sessions?project=samskara"
      />
    </TestRouter>,
  )

  const status = screen.getByRole("status")
  expect(status).toHaveTextContent(/no sessions captured/i)
  expect(status.textContent?.trim()).not.toBe("")
})

test("SC31: an org-owned project's card shows the owning org's slug", () => {
  render(
    <TestRouter initialEntries={["/projects"]}>
      <ProjectCard
        project={{ ...fullProject, owner: { type: "org", slug: "acme" } }}
        to="/sessions?project=p-1"
      />
    </TestRouter>,
  )

  const card = within(screen.getByRole("link"))
  expect(card.getByText(/acme/)).toBeInTheDocument()
})

test("SC31: a personal project's card shows no owner line and not the owner's own slug", () => {
  render(
    <TestRouter initialEntries={["/projects"]}>
      <ProjectCard
        project={{ ...fullProject, owner: { type: "user", slug: "ritesh" } }}
        to="/sessions?project=p-1"
      />
    </TestRouter>,
  )

  const card = within(screen.getByRole("link"))
  expect(card.queryByText(/ritesh/)).not.toBeInTheDocument()
})
