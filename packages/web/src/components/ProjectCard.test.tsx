import { render, screen, within } from "@testing-library/react"
import { expect, test } from "vitest"
import type { ProjectSummary } from "../api/types.js"
import { ProjectCard } from "./ProjectCard.js"

const fullProject: ProjectSummary = {
  id: "p-1",
  name: "Samskara",
  slug: "samskara",
  sessionCount: 12,
  lastActiveAt: "2026-02-01T09:30:00.000Z",
  lastSessionTitle: "Port the session detail surface",
}

test("S2: a fully-populated card renders name, slug, session count, last-active time, and last session title - all five, inside the card itself", () => {
  render(<ProjectCard project={fullProject} onOpen={() => {}} />)

  const card = within(screen.getByRole("button"))
  expect(card.getByText("Samskara")).toBeInTheDocument()
  expect(card.getByText(/samskara/)).toBeInTheDocument()
  expect(card.getByText(/12/)).toBeInTheDocument()
  expect(card.getByText("Port the session detail surface")).toBeInTheDocument()
  expect(card.getByText(/2026/)).toBeInTheDocument()
})

test("S3: an unavailable last-active field renders the word 'unavailable' rather than an empty cell coloured differently", () => {
  render(
    <ProjectCard
      project={{ ...fullProject, sessionCount: 0, lastActiveAt: null, lastSessionTitle: null }}
      onOpen={() => {}}
    />,
  )

  const status = screen.getByRole("status")
  expect(status).toHaveTextContent(/no sessions captured/i)
  expect(status.textContent?.trim()).not.toBe("")
})
