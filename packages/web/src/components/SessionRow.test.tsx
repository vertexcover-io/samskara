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
  repo: { host: "github.com", owner: "acme", repoName: "samskara" },
  durationMs: 3_723_000,
  tokensTotal: 128_400,
  status: "complete",
  lastActiveAt: "2026-02-01T09:30:00.000Z",
}

test("S18: a row summarises the session on one line - title, who, duration, tokens, project", () => {
  render(<SessionRow session={populated} onOpen={vi.fn()} />)

  const row = screen.getByRole("button")

  expect(row).toHaveTextContent("Port the session detail surface")
  expect(row).toHaveTextContent("Samskara")
  expect(row).toHaveTextContent("maya")
  expect(row).toHaveTextContent("acme/samskara")
  expect(row).toHaveTextContent("1h 2m")
  expect(row).toHaveTextContent("128.4k tokens")
})

test("S18: a session with no repo omits it rather than reserving a placeholder for it", () => {
  render(<SessionRow session={{ ...populated, repo: null }} onOpen={vi.fn()} />)

  const row = screen.getByRole("button")
  expect(row).toHaveTextContent("maya · 1h 2m")
  expect(row).not.toHaveTextContent("unavailable")
})

test("S18: a remoteless repo reads as its own name - never the absolute path it is keyed by", () => {
  const repo = { host: "local", owner: "/Users/maya/Projects/samskara", repoName: "samskara" }
  render(<SessionRow session={{ ...populated, repo }} onOpen={vi.fn()} />)

  const row = screen.getByRole("button")
  expect(row).toHaveTextContent("samskara")
  expect(row).not.toHaveTextContent("/Users/maya")
})

test("S26: the row reports capture recency in relative terms rather than a raw timestamp", () => {
  render(<SessionRow session={populated} onOpen={vi.fn()} />)

  expect(screen.getByRole("button")).not.toHaveTextContent("2026-02-01T09:30")
})

test("S19: a null duration renders an explicit placeholder - never 0, an em dash, or a fabricated value", () => {
  render(<SessionRow session={{ ...populated, durationMs: null }} onOpen={vi.fn()} />)

  expect(screen.getByText("unavailable")).toBeInTheDocument()

  const row = screen.getByRole("button")
  expect(row).toHaveTextContent("unavailable")
  expect(row).not.toHaveTextContent("null")
  expect(row).not.toHaveTextContent("—")
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
