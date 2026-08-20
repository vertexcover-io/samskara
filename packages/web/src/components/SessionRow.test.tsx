import { render, screen } from "@testing-library/react"
import { expect, test } from "vitest"
import type { SessionSummary } from "../api/types.js"
import { TestRouter } from "../tests/test-router.js"
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
  snippet: null,
}

const renderRow = (session: SessionSummary) =>
  render(
    <TestRouter initialEntries={["/sessions"]}>
      <SessionRow session={session} to={`/sessions/${session.id}`} />
    </TestRouter>,
  )

test("S18: a row summarises the session on one line - title, who, duration, tokens, project", () => {
  renderRow(populated)

  const row = screen.getByRole("link")

  expect(row).toHaveTextContent("Port the session detail surface")
  expect(row).toHaveTextContent("Samskara")
  expect(row).toHaveTextContent("maya")
  expect(row).toHaveTextContent("acme/samskara")
  expect(row).toHaveTextContent("1h 2m")
  expect(row).toHaveTextContent("128.4k tokens")
})

test("S18: a session with no repo omits it rather than reserving a placeholder for it", () => {
  renderRow({ ...populated, repo: null })

  const row = screen.getByRole("link")
  expect(row).toHaveTextContent("maya · 1h 2m")
  expect(row).not.toHaveTextContent("unavailable")
})

test("S18: a remoteless repo reads as its own name - never the absolute path it is keyed by", () => {
  const repo = { host: "local", owner: "/Users/maya/Projects/samskara", repoName: "samskara" }
  renderRow({ ...populated, repo })

  const row = screen.getByRole("link")
  expect(row).toHaveTextContent("samskara")
  expect(row).not.toHaveTextContent("/Users/maya")
})

test("S26: the row reports capture recency in relative terms rather than a raw timestamp", () => {
  renderRow(populated)

  expect(screen.getByRole("link")).not.toHaveTextContent("2026-02-01T09:30")
})

test("S26: the relative stamp carries the exact moment as a tooltip, so recency never costs precision", () => {
  renderRow(populated)

  expect(screen.getByRole("time")).toHaveAttribute("title", "Feb 1, 2026, 09:30")
})

test("S19: a null duration renders an explicit placeholder - never 0, an em dash, or a fabricated value", () => {
  renderRow({ ...populated, durationMs: null })

  expect(screen.getByText("unavailable")).toBeInTheDocument()

  const row = screen.getByRole("link")
  expect(row).toHaveTextContent("unavailable")
  expect(row).not.toHaveTextContent("null")
  expect(row).not.toHaveTextContent("—")
})

test("S19: a null title reads as 'untitled session' rather than an empty heading", () => {
  renderRow({ ...populated, title: null })

  expect(screen.getByRole("link")).toHaveTextContent("untitled session")
})

test("S26: a zero token total renders as 0 - the 'unavailable' path is reserved for genuinely absent data", () => {
  renderRow({ ...populated, tokensTotal: 0 })

  expect(screen.getByRole("link")).toHaveTextContent("0")
  expect(screen.queryByText("unavailable")).not.toBeInTheDocument()
})

test("S26: token totals scale past thousands rather than reading as five-figure 'k'", () => {
  renderRow({ ...populated, tokensTotal: 12_400_000 })
  expect(screen.getByRole("link")).toHaveTextContent("12.4M tokens")

  renderRow({ ...populated, tokensTotal: 2_500_000_000 })
  expect(screen.getAllByRole("link")[1]).toHaveTextContent("2.5B tokens")
})

test("S26: the row is a link, so a session opens in a new tab the way any other link does", () => {
  renderRow(populated)

  expect(screen.getByRole("link")).toHaveAttribute("href", "/sessions/s-1")
})

test("SC28: a row renders the matched text as a mark", () => {
  renderRow({ ...populated, snippet: "a [[hl]]timeout[[/hl]] here" })

  const row = screen.getByRole("link")
  expect(row).toHaveTextContent("a timeout here")

  const mark = screen.getByText("timeout")
  expect(mark.tagName).toBe("MARK")
})

test("SC29: a row renders snippet text literally, never as markup", () => {
  renderRow({ ...populated, snippet: "<img src=x onerror=alert(1)>" })

  const row = screen.getByRole("link")
  expect(row).toHaveTextContent("<img src=x onerror=alert(1)>")
  expect(row.querySelector("img")).toBeNull()
})

test("SC30: a row with no snippet renders no snippet line", () => {
  renderRow({ ...populated, snippet: null })

  const row = screen.getByRole("link")
  expect(row).toHaveTextContent("Port the session detail surface")
  expect(row.querySelector("mark")).toBeNull()
})
