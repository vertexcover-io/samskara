import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, expect, test, vi } from "vitest"
import type { CapturedArtifact } from "../api/types.js"
import { ArtifactsView } from "./ArtifactsView.js"
import type { Artifact } from "./records.js"

afterEach(() => {
  vi.unstubAllGlobals()
})

const captured = (overrides: Partial<CapturedArtifact> = {}): CapturedArtifact => ({
  id: "c-1",
  path: "/work/acme/docs/notes.md",
  relativePath: "docs/notes.md",
  mimeType: "text/markdown",
  isBinary: false,
  changeKind: "edited",
  diff: null,
  oldFragment: null,
  editCount: 1,
  firstSeenAt: "2026-07-01T10:00:00.000Z",
  lastSeenAt: "2026-07-01T10:05:00.000Z",
  ...overrides,
})

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

test("S48: captured artifacts are listed by relative path and selecting one shows it in the viewer", async () => {
  const user = userEvent.setup()
  render(
    <ArtifactsView
      artifacts={[
        captured({ id: "c-1", relativePath: "docs/notes.md" }),
        captured({ id: "c-2", relativePath: "src/ingest.ts", mimeType: "text/x-typescript" }),
      ]}
    />,
  )

  const list = screen.getByRole("list", { name: /filed artifacts/i })
  expect(within(list).getByRole("button", { name: /docs\/notes\.md/ })).toBeInTheDocument()
  expect(within(list).getByRole("button", { name: /src\/ingest\.ts/ })).toBeInTheDocument()

  await user.click(within(list).getByRole("button", { name: /src\/ingest\.ts/ }))

  const viewer = screen.getByRole("region", { name: /artifact viewer/i })
  expect(within(viewer).getByText("src/ingest.ts")).toBeInTheDocument()
})

test("S50: an edited artifact renders its diff with added and removed lines distinguishable from context", () => {
  render(
    <ArtifactsView
      artifacts={[
        captured({
          diff: "@@ -1,3 +1,3 @@\n # Notes\n-The original line.\n+The replacement line.\n",
        }),
      ]}
    />,
  )

  const viewer = screen.getByRole("region", { name: /artifact viewer/i })
  const removed = within(viewer).getByText("-The original line.")
  const added = within(viewer).getByText("+The replacement line.")
  const context = within(viewer).getByText("# Notes")

  expect(removed.className).not.toBe(context.className)
  expect(added.className).not.toBe(context.className)
  expect(added.className).not.toBe(removed.className)
})

test("S51: an artifact with no resolvable base shows its replaced excerpt labelled as an excerpt, not a diff", () => {
  render(
    <ArtifactsView
      artifacts={[
        captured({
          changeKind: "editedUnknownBase",
          diff: null,
          oldFragment: "The original line.",
        }),
      ]}
    />,
  )

  const viewer = screen.getByRole("region", { name: /artifact viewer/i })
  expect(within(viewer).getByText(/The original line\./)).toBeInTheDocument()
  expect(within(viewer).getByText(/replaced excerpt/i)).toBeInTheDocument()
  expect(within(viewer).queryByText(/no contents captured/i)).not.toBeInTheDocument()
  expect(within(viewer).queryByText(/permission denied/i)).not.toBeInTheDocument()
})

test("S52: a created artifact shows its content, without offering a diff pane", async () => {
  // A created file has no diff and no replaced excerpt, so its body is the ONLY thing there is to
  // show. The list route withholds it, so the view fetches it from the raw route.
  const body = "# Fresh notes\n\nWritten by the agent this session."
  const calls: string[] = []
  vi.stubGlobal("fetch", (url: string) => {
    calls.push(url)
    return Promise.resolve(new Response(body, { status: 200 }))
  })

  render(
    <ArtifactsView
      artifacts={[captured({ changeKind: "created", diff: null, oldFragment: null, editCount: 0 })]}
    />,
  )

  const viewer = screen.getByRole("region", { name: /artifact viewer/i })
  expect(within(viewer).getByText("docs/notes.md")).toBeInTheDocument()
  expect(within(viewer).getByText(/created/i)).toBeInTheDocument()

  // The content itself must reach the screen -- asserting only the path and the changeKind is what
  // let a version ship that rendered "no contents captured" for every created file.
  expect(await within(viewer).findByText(/Written by the agent this session/)).toBeInTheDocument()
  expect(calls).toEqual(["/api/artifacts/c-1/raw?which=current"])

  expect(within(viewer).queryByText(/replaced excerpt/i)).not.toBeInTheDocument()
  expect(within(viewer).queryByText(/^@@/)).not.toBeInTheDocument()
  expect(within(viewer).queryByText(/no contents captured/i)).not.toBeInTheDocument()
})

test("S52: a created artifact whose body cannot be read degrades to a notice, not a blank pane", async () => {
  vi.stubGlobal("fetch", () => Promise.resolve(new Response("nope", { status: 500 })))

  render(<ArtifactsView artifacts={[captured({ changeKind: "created", editCount: 0 })]} />)

  const viewer = screen.getByRole("region", { name: /artifact viewer/i })
  expect(await within(viewer).findByText(/contents unavailable/i)).toBeInTheDocument()
})

test("S48: a binary captured artifact points its media at the raw route rather than a data url", () => {
  render(
    <ArtifactsView
      artifacts={[
        captured({
          id: "c-img",
          relativePath: "docs/architecture.png",
          mimeType: "image/png",
          isBinary: true,
          changeKind: "created",
        }),
      ]}
    />,
  )

  const image = screen.getByRole("img", { name: /architecture\.png/ })
  expect(image).toHaveAttribute("src", "/api/artifacts/c-img/raw?which=current")
})

test("S53: transcript frame-link artifacts and captured files render side by side, captured first", () => {
  render(
    <ArtifactsView
      artifacts={[captured({ id: "c-1", relativePath: "docs/notes.md" }), ...ARTIFACTS]}
    />,
  )

  const list = screen.getByRole("list", { name: /filed artifacts/i })
  const names = within(list)
    .getAllByRole("button")
    .map((button) => button.textContent ?? "")

  expect(names[0]).toContain("docs/notes.md")
  expect(names[1]).toContain("0007_add_source_uid.sql")
  expect(names[2]).toContain("idempotency-design.md")
})
