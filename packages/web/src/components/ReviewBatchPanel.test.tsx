import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter } from "react-router-dom"
import { expect, test, vi } from "vitest"
import type { ReviewBatchView } from "../api/types.js"
import { ReviewBatchPanel } from "./ReviewBatchPanel.js"

const batch: ReviewBatchView = {
  batchId: "b-1",
  status: "running",
  startedAt: "2026-11-02T10:00:00.000Z",
  sessions: [
    { sessionId: "s-reviewed", projectId: "p-a", title: "One", state: "reviewed", reason: null },
    { sessionId: "s-skipped", projectId: "p-a", title: "Two", state: "skipped", reason: null },
    {
      sessionId: "s-failed",
      projectId: "p-b",
      title: "Fix the login page",
      state: "failed",
      reason: "The reviewer stopped with an error.",
    },
    { sessionId: "s-hidden", projectId: null, title: null, state: "notAllowed", reason: null },
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
      <ReviewBatchPanel batch={batch} onDismiss={() => {}} />
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

test("a failed review is named by its session's title, linked to the session", () => {
  render(
    <MemoryRouter>
      <ReviewBatchPanel batch={batch} onDismiss={() => {}} />
    </MemoryRouter>,
  )
  const why = screen.getByText("Why 1 review failed").closest("details") as HTMLElement
  expect(within(why).getByRole("link", { name: "Fix the login page" })).toHaveAttribute(
    "href",
    "/sessions/s-failed",
  )
  expect(within(why).queryByText("s-failed")).toBeNull()
})

test("a failed review of a session with no title is named by its id", () => {
  const untitled: ReviewBatchView = {
    ...batch,
    sessions: batch.sessions.map((session) =>
      session.sessionId === "s-failed" ? { ...session, title: null } : session,
    ),
  }
  render(
    <MemoryRouter>
      <ReviewBatchPanel batch={untitled} onDismiss={() => {}} />
    </MemoryRouter>,
  )
  const why = screen.getByText("Why 1 review failed").closest("details") as HTMLElement
  expect(within(why).getByRole("link", { name: "s-failed" })).toBeInTheDocument()
})

test("a running batch has no dismiss button", () => {
  render(
    <MemoryRouter>
      <ReviewBatchPanel batch={batch} onDismiss={() => {}} />
    </MemoryRouter>,
  )
  expect(screen.queryByRole("button", { name: "Dismiss review progress" })).toBeNull()
})

test("a finished batch has a dismiss button that calls onDismiss", async () => {
  const onDismiss = vi.fn()
  render(
    <MemoryRouter>
      <ReviewBatchPanel batch={{ ...batch, status: "done" }} onDismiss={onDismiss} />
    </MemoryRouter>,
  )
  await userEvent.click(screen.getByRole("button", { name: "Dismiss review progress" }))
  expect(onDismiss).toHaveBeenCalledOnce()
})
