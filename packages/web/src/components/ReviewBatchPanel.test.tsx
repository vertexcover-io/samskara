import { render, screen, within } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { expect, test } from "vitest"
import type { ReviewBatchView } from "../api/types.js"
import { ReviewBatchPanel } from "./ReviewBatchPanel.js"

const batch: ReviewBatchView = {
  batchId: "b-1",
  status: "running",
  startedAt: "2026-11-02T10:00:00.000Z",
  sessions: [
    { sessionId: "s-reviewed", projectId: "p-a", state: "reviewed", reason: null },
    { sessionId: "s-skipped", projectId: "p-a", state: "skipped", reason: null },
    {
      sessionId: "s-failed",
      projectId: "p-b",
      state: "failed",
      reason: "The reviewer stopped with an error.",
    },
    { sessionId: "s-hidden", projectId: null, state: "notAllowed", reason: null },
  ],
  projects: [
    { projectId: "p-a", name: "A", state: "done", reason: null },
    {
      projectId: "p-b",
      name: "B",
      state: "failed",
      reason: "No session of this project got a review.",
    },
    { projectId: "p-c", name: "C", state: "waiting", reason: null },
  ],
}

test("SC20: the panel shows each count, each project's state, and a Fixes link only for a done project", () => {
  render(
    <MemoryRouter>
      <ReviewBatchPanel batch={batch} />
    </MemoryRouter>,
  )
  const panel = screen.getByRole("region", { name: "Review progress" })
  for (const text of ["1 reviewed", "1 skipped (already reviewed)", "1 failed", "1 not allowed"])
    expect(within(panel).getByText(text)).toBeInTheDocument()

  expect(screen.getByRole("link", { name: "See fixes for A" })).toHaveAttribute(
    "href",
    "/learnings?project=p-a",
  )
  const projectB = screen.getByText("B").closest("li") as HTMLElement
  expect(within(projectB).getByText("Failed")).toBeInTheDocument()
  expect(within(projectB).getByText("No session of this project got a review.")).toBeInTheDocument()
  expect(within(projectB).queryByRole("link")).toBeNull()
  const projectC = screen.getByText("C").closest("li") as HTMLElement
  expect(within(projectC).getByText("Waiting")).toBeInTheDocument()
  expect(within(projectC).queryByRole("link")).toBeNull()

  const why = screen.getByText("Why 1 review failed").closest("details") as HTMLElement
  expect(within(why).getByText(/The reviewer stopped with an error\./)).toBeInTheDocument()
})
