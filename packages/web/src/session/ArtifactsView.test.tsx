import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { expect, test } from "vitest"
import { ArtifactsView } from "./ArtifactsView.js"
import type { Artifact } from "./records.js"

const ARTIFACTS: ReadonlyArray<Artifact> = [
  {
    id: "e-1",
    path: "migrations/0007_add_source_uid.sql",
    url: null,
    title: "Migration",
    timestamp: "2026-03-01T10:00:00.000Z",
  },
  {
    id: "e-2",
    path: "docs/idempotency-design.md",
    url: null,
    title: null,
    timestamp: "2026-03-01T10:05:00.000Z",
  },
]

test("S37: the artifact list selects the first exhibit on load and the viewer shows that exhibit's path", () => {
  render(<ArtifactsView artifacts={ARTIFACTS} />)

  const list = screen.getByRole("list", { name: /filed artifacts/i })
  const [first] = within(list).getAllByRole("button")
  expect(first).toHaveAttribute("aria-current", "true")

  const viewer = screen.getByRole("region", { name: /artifact viewer/i })
  expect(within(viewer).getByText("migrations/0007_add_source_uid.sql")).toBeInTheDocument()
})

test("S37: choosing a second exhibit moves the selection and swaps the viewer to that artifact", async () => {
  const user = userEvent.setup()
  render(<ArtifactsView artifacts={ARTIFACTS} />)

  const list = screen.getByRole("list", { name: /filed artifacts/i })
  await user.click(within(list).getByRole("button", { name: /idempotency-design\.md/ }))

  const viewer = screen.getByRole("region", { name: /artifact viewer/i })
  expect(within(viewer).getByText("docs/idempotency-design.md")).toBeInTheDocument()
  expect(within(list).getByRole("button", { name: /idempotency-design\.md/ })).toHaveAttribute(
    "aria-current",
    "true",
  )
})

test("S37: the narrow-screen selector mirrors the list, so choosing there swaps the viewer too", async () => {
  const user = userEvent.setup()
  render(<ArtifactsView artifacts={ARTIFACTS} />)

  await user.selectOptions(screen.getByRole("combobox", { name: /choose an artifact/i }), "e-2")

  const viewer = screen.getByRole("region", { name: /artifact viewer/i })
  expect(within(viewer).getByText("docs/idempotency-design.md")).toBeInTheDocument()
})

test("S37: an artifact with no path and no url renders as unavailable rather than an empty row", () => {
  render(
    <ArtifactsView
      artifacts={[{ id: "e-3", path: null, url: null, title: null, timestamp: null }]}
    />,
  )

  expect(screen.getAllByText(/unavailable/i).length).toBeGreaterThan(0)
})

test("EDGE: a session that filed no artifacts explains the absence instead of rendering an empty browser", () => {
  render(<ArtifactsView artifacts={[]} />)

  expect(screen.getByText(/no artifacts were filed/i)).toBeInTheDocument()
  expect(screen.queryByRole("list", { name: /filed artifacts/i })).not.toBeInTheDocument()
})
