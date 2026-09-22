import { render, screen } from "@testing-library/react"
import { expect, test } from "vitest"
import type { SessionSummary } from "../api/types.js"
import { TestRouter } from "../tests/test-router.js"
import { SessionRow } from "./SessionRow.js"

const populated: SessionSummary = {
  id: "s-1",
  title: "Port the session detail surface",
  projectId: "p-1",
  projectName: "Samskara",
  projectSlug: "samskara",
  userLogin: "maya",
  messageCount: 1_240,
  status: "complete",
  startedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
  lastActiveAt: "2026-02-01T09:30:00.000Z",
  hasAiReview: false,
  tags: ["harness"],
}

const renderRow = (session: SessionSummary) =>
  render(
    <TestRouter initialEntries={["/sessions"]}>
      <SessionRow session={session} to={`/sessions/${session.id}`} />
    </TestRouter>,
  )

test("SC8: the row names the session, who ran it, how many messages it holds and when it started", () => {
  renderRow(populated)

  const row = screen.getByRole("link")
  expect(row).toHaveTextContent("Port the session detail surface")
  expect(row).toHaveTextContent("Samskara")
  expect(row).toHaveTextContent("maya")
  expect(row).toHaveTextContent("1240 messages")
  expect(row).toHaveTextContent(/started 2 hours? ago/)
  expect(row).not.toHaveTextContent("tokens")
})

test("SC9: a session with no messages reports a placeholder for its start, not a zero", () => {
  renderRow({ ...populated, messageCount: 0, startedAt: null })

  const row = screen.getByRole("link")
  expect(row).toHaveTextContent("0 messages")
  expect(screen.getByText("unavailable")).toBeInTheDocument()
  expect(row).not.toHaveTextContent("null")
  expect(row).not.toHaveTextContent("—")
})

test("SC10: a single-message session reads '1 message', not '1 messages'", () => {
  renderRow({ ...populated, messageCount: 1 })

  const row = screen.getByRole("link")
  expect(row).toHaveTextContent("1 message")
  expect(row).not.toHaveTextContent("1 messages")
})

test("S19: a null title reads as 'untitled session' rather than an empty heading", () => {
  renderRow({ ...populated, title: null })

  expect(screen.getByRole("link")).toHaveTextContent("untitled session")
})

test("S26: the row reports capture recency in relative terms rather than a raw timestamp", () => {
  renderRow(populated)

  expect(screen.getByRole("link")).not.toHaveTextContent("2026-02-01T09:30")
})

test("S26: the relative stamp carries the exact moment as a tooltip, so recency never costs precision", () => {
  renderRow(populated)

  expect(screen.getByRole("time")).toHaveAttribute("title", "Feb 1, 2026, 09:30")
})

test("S26: the row is a link, so a session opens in a new tab the way any other link does", () => {
  renderRow(populated)

  expect(screen.getByRole("link")).toHaveAttribute("href", "/sessions/s-1")
})

test("S44: a session with a landed AI review wears a badge", () => {
  renderRow({ ...populated, hasAiReview: true })
  expect(screen.getByText("AI review")).toBeInTheDocument()
})

test("S44: a session the AI review has not reached carries no badge", () => {
  renderRow({ ...populated, hasAiReview: false })
  expect(screen.queryByText("AI review")).not.toBeInTheDocument()
})

test("search evidence renders a supported source label and escaped highlighted text", () => {
  renderRow({
    ...populated,
    match: {
      sourceKind: "toolResult",
      sourceRowId: "tool-1",
      score: 1.5,
      snippet: [
        { text: "The <script> value ", highlighted: false },
        { text: "timed out", highlighted: true },
      ],
    },
  })

  expect(screen.getByRole("link")).toHaveTextContent("Tool result")
  expect(document.querySelector("mark")).toHaveTextContent("timed out")
  expect(screen.getByText("The <script> value", { exact: false }).tagName).toBe("SPAN")
  expect(document.querySelector("script")).toBeNull()
})

test("a non-search row has no evidence label or mark", () => {
  renderRow(populated)
  expect(screen.queryByRole("mark")).not.toBeInTheDocument()
  expect(screen.queryByText("Tool result")).not.toBeInTheDocument()
})
