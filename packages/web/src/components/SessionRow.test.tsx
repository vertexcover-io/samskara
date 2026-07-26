import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { expect, test, vi } from "vitest"
import type { SessionSummary } from "../api/types.js"
import { SessionRow } from "./SessionRow.js"

const populated: SessionSummary = {
  id: "s-1",
  title: "Port the session detail surface",
  projectName: "Samskara",
  projectSlug: "samskara",
  userLogin: "maya",
  model: "claude-opus-5",
  durationMs: 3_723_000,
  tokensTotal: 128_400,
  status: "complete",
  lastActiveAt: "2026-02-01T09:30:00.000Z",
}

test("S18: a fully-populated row shows all eight fields including the humanized duration and grouped token total", () => {
  render(<SessionRow session={populated} onOpen={vi.fn()} />)

  const row = screen.getByRole("button")

  expect(row).toHaveTextContent("Port the session detail surface")
  expect(row).toHaveTextContent("Samskara")
  expect(row).toHaveTextContent("maya")
  expect(row).toHaveTextContent("claude-opus-5")
  expect(row).toHaveTextContent("1h 2m")
  expect(row).toHaveTextContent("128,400")
  expect(row).toHaveTextContent(/complete/i)
  expect(row).toHaveTextContent("2026-02-01 09:30")
})

test("S26: status is announced with a word, so it never depends on color alone", () => {
  render(<SessionRow session={populated} onOpen={vi.fn()} />)

  expect(screen.getByRole("status")).toHaveTextContent(/complete/i)
})

test("S19: a null model and duration each render an explicit 'unavailable' label - never 0, an em dash, or a fabricated value", () => {
  render(<SessionRow session={{ ...populated, model: null, durationMs: null }} onOpen={vi.fn()} />)

  expect(screen.getAllByText("unavailable")).toHaveLength(2)

  const row = screen.getByRole("button")
  expect(row).not.toHaveTextContent("null")
  expect(row).not.toHaveTextContent("—")
  expect(row).not.toHaveTextContent("0h 0m")
})

test("S19: a null title reads as 'untitled session' rather than an empty heading", () => {
  render(<SessionRow session={{ ...populated, title: null }} onOpen={vi.fn()} />)

  expect(screen.getByRole("button")).toHaveTextContent("untitled session")
})

test("S26: a zero token total renders as 0 - the 'unavailable' path is reserved for genuinely absent data", () => {
  render(<SessionRow session={{ ...populated, tokensTotal: 0 }} onOpen={vi.fn()} />)

  expect(screen.getByRole("button")).toHaveTextContent("0")
  expect(screen.queryByText("unavailable")).not.toBeInTheDocument()
})

test("S26: activating the row hands its session back to the caller", async () => {
  const onOpen = vi.fn()
  render(<SessionRow session={populated} onOpen={onOpen} />)

  await userEvent.click(screen.getByRole("button"))

  expect(onOpen).toHaveBeenCalledWith(populated)
})
