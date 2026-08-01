import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, expect, test, vi } from "vitest"
import type { CapturedArtifact } from "../api/types.js"
import { TestRouter } from "../tests/test-router.js"
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
  render(
    <TestRouter initialEntries={["/s/1?tab=artifacts"]}>
      <ArtifactsView artifacts={ARTIFACTS} />
    </TestRouter>,
  )

  const list = screen.getByRole("list", { name: /filed artifacts/i })
  // Exactly one file is current on load -- the first of the supplied artifacts, wherever the
  // tree's alphabetical ordering happens to place it.
  const current = within(list)
    .getAllByRole("button")
    .filter((button) => button.getAttribute("aria-current") === "true")
  expect(current).toHaveLength(1)
  expect(current[0]?.textContent).toContain("0007_add_source_uid.sql")

  const viewer = screen.getByRole("region", { name: /artifact viewer/i })
  expect(within(viewer).getByText("migrations/0007_add_source_uid.sql")).toBeInTheDocument()
})

test("S37: choosing a second exhibit moves the selection and swaps the viewer to that artifact", async () => {
  const user = userEvent.setup()
  render(
    <TestRouter initialEntries={["/s/1?tab=artifacts"]}>
      <ArtifactsView artifacts={ARTIFACTS} />
    </TestRouter>,
  )

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
  render(
    <TestRouter initialEntries={["/s/1?tab=artifacts"]}>
      <ArtifactsView artifacts={ARTIFACTS} />
    </TestRouter>,
  )

  await user.selectOptions(screen.getByRole("combobox", { name: /choose an artifact/i }), "e-2")

  const viewer = screen.getByRole("region", { name: /artifact viewer/i })
  expect(within(viewer).getByText("docs/idempotency-design.md")).toBeInTheDocument()
})

test("S37: an artifact with no path and no url renders as unavailable rather than an empty row", () => {
  render(
    <TestRouter initialEntries={["/s/1?tab=artifacts"]}>
      <ArtifactsView
        artifacts={[{ id: "e-3", path: null, url: null, title: null, timestamp: null }]}
      />
    </TestRouter>,
  )

  expect(screen.getAllByText(/unavailable/i).length).toBeGreaterThan(0)
})

test("EDGE: a session that filed no artifacts explains the absence instead of rendering an empty browser", () => {
  render(
    <TestRouter initialEntries={["/s/1?tab=artifacts"]}>
      <ArtifactsView artifacts={[]} />
    </TestRouter>,
  )

  expect(screen.getByText(/no artifacts were filed/i)).toBeInTheDocument()
  expect(screen.queryByRole("list", { name: /filed artifacts/i })).not.toBeInTheDocument()
})

test("S48: captured artifacts are listed by relative path and selecting one shows it in the viewer", async () => {
  const user = userEvent.setup()
  render(
    <TestRouter initialEntries={["/s/1?tab=artifacts"]}>
      <ArtifactsView
        artifacts={[
          captured({ id: "c-1", relativePath: "docs/notes.md" }),
          captured({ id: "c-2", relativePath: "src/ingest.ts", mimeType: "text/x-typescript" }),
        ]}
      />
    </TestRouter>,
  )

  const list = screen.getByRole("list", { name: /filed artifacts/i })
  // A file browser lists leaf names under folder rows, so the folders carry the path.
  expect(within(list).getByRole("button", { name: /^docs$/ })).toBeInTheDocument()
  expect(within(list).getByRole("button", { name: /^src$/ })).toBeInTheDocument()
  expect(within(list).getByRole("button", { name: /notes\.md/ })).toBeInTheDocument()

  await user.click(within(list).getByRole("button", { name: /ingest\.ts/ }))

  const viewer = screen.getByRole("region", { name: /artifact viewer/i })
  expect(within(viewer).getByText("src/ingest.ts")).toBeInTheDocument()
})

test("S50: an edited artifact renders its diff with added and removed lines distinguishable from context", () => {
  render(
    <TestRouter initialEntries={["/s/1?tab=artifacts"]}>
      <ArtifactsView
        artifacts={[
          captured({
            diff: "@@ -1,3 +1,3 @@\n # Notes\n-The original line.\n+The replacement line.\n",
          }),
        ]}
      />
    </TestRouter>,
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
    <TestRouter initialEntries={["/s/1?tab=artifacts"]}>
      <ArtifactsView
        artifacts={[
          captured({
            changeKind: "editedUnknownBase",
            diff: null,
            oldFragment: "The original line.",
          }),
        ]}
      />
    </TestRouter>,
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
    <TestRouter initialEntries={["/s/1?tab=artifacts"]}>
      <ArtifactsView
        artifacts={[
          captured({ changeKind: "created", diff: null, oldFragment: null, editCount: 0 }),
        ]}
      />
    </TestRouter>,
  )

  const viewer = screen.getByRole("region", { name: /artifact viewer/i })
  expect(within(viewer).getByText("docs/notes.md")).toBeInTheDocument()
  expect(within(viewer).getByText(/created/i)).toBeInTheDocument()

  // The content itself must reach the screen -- asserting only the path and the changeKind is what
  // let a version ship that rendered "no contents captured" for every created file.
  expect(await within(viewer).findByText(/Written by the agent this session/)).toBeInTheDocument()
  // The router's AuthProvider also calls /api/auth/me; assert on the artifact fetch specifically.
  expect(calls.filter((url) => url.startsWith("/api/artifacts"))).toEqual([
    "/api/artifacts/c-1/raw?which=current",
  ])

  expect(within(viewer).queryByText(/replaced excerpt/i)).not.toBeInTheDocument()
  expect(within(viewer).queryByText(/^@@/)).not.toBeInTheDocument()
  expect(within(viewer).queryByText(/no contents captured/i)).not.toBeInTheDocument()
})

test("S52: a created artifact whose body cannot be read degrades to a notice, not a blank pane", async () => {
  vi.stubGlobal("fetch", () => Promise.resolve(new Response("nope", { status: 500 })))

  render(
    <TestRouter initialEntries={["/s/1?tab=artifacts"]}>
      <ArtifactsView artifacts={[captured({ changeKind: "created", editCount: 0 })]} />
    </TestRouter>,
  )

  const viewer = screen.getByRole("region", { name: /artifact viewer/i })
  expect(await within(viewer).findByText(/contents unavailable/i)).toBeInTheDocument()
})

test("S55: each file row says whether it was created or edited, so the tree is scannable", () => {
  render(
    <TestRouter initialEntries={["/s/1?tab=artifacts"]}>
      <ArtifactsView
        artifacts={[
          captured({ id: "c-new", relativePath: "src/added.ts", changeKind: "created" }),
          captured({ id: "c-mod", relativePath: "src/changed.ts", changeKind: "edited" }),
          captured({
            id: "c-unk",
            relativePath: "src/guessed.ts",
            changeKind: "editedUnknownBase",
          }),
        ]}
      />
    </TestRouter>,
  )

  const list = screen.getByRole("list", { name: /filed artifacts/i })
  const rowFor = (name: RegExp) => within(list).getByRole("button", { name }).textContent ?? ""

  // The status leads the row, the way `git status` puts it in the margin.
  expect(rowFor(/added\.ts/)).toMatch(/^Created\b/)
  expect(rowFor(/changed\.ts/)).toMatch(/^Edited\b/)
  // An unresolved base is still an edit; the row must not imply the file is new.
  expect(rowFor(/guessed\.ts/)).toMatch(/^Edited\b/)
})

test("S55: a frame-link artifact has no change kind and gets no marker rather than a wrong one", () => {
  render(
    <TestRouter initialEntries={["/s/1?tab=artifacts"]}>
      <ArtifactsView artifacts={ARTIFACTS} />
    </TestRouter>,
  )

  const list = screen.getByRole("list", { name: /filed artifacts/i })
  const row = within(list).getByRole("button", { name: /idempotency-design\.md/ })
  expect(row.textContent).not.toMatch(/created|edited/i)
})

test("S54: an agent-authored HTML file renders as a page, not as syntax-highlighted source", () => {
  render(
    <TestRouter initialEntries={["/s/1?tab=artifacts"]}>
      <ArtifactsView
        artifacts={[
          captured({
            id: "c-html",
            relativePath: "reports/proof.html",
            mimeType: "text/html",
            changeKind: "created",
            editCount: 0,
          }),
        ]}
      />
    </TestRouter>,
  )

  const frame = screen.getByTitle(/rendered preview of reports\/proof\.html/i)
  expect(frame.tagName).toBe("IFRAME")
  expect(frame).toHaveAttribute("src", "/api/artifacts/c-html/raw?which=current")
})

test("S54: the preview frame is sandboxed without allow-same-origin, which would void the sandbox", () => {
  // `allow-scripts` plus `allow-same-origin` lets a script inside remove its own sandbox and
  // reload with full origin access. The server sends the same policy as a CSP header; the
  // attribute repeats it so a cached response cannot arrive unsandboxed.
  render(
    <TestRouter initialEntries={["/s/1?tab=artifacts"]}>
      <ArtifactsView
        artifacts={[
          captured({
            id: "c-html",
            relativePath: "reports/proof.html",
            mimeType: "text/html",
            changeKind: "created",
            editCount: 0,
          }),
        ]}
      />
    </TestRouter>,
  )

  const sandbox = screen.getByTitle(/rendered preview/i).getAttribute("sandbox") ?? ""
  expect(sandbox.split(/\s+/)).toContain("allow-scripts")
  expect(sandbox).not.toContain("allow-same-origin")
})

test("S54: an edited HTML file still opens on its diff, with the rendered page one click away", async () => {
  const user = userEvent.setup()
  render(
    <TestRouter initialEntries={["/s/1?tab=artifacts"]}>
      <ArtifactsView
        artifacts={[
          captured({
            id: "c-html",
            relativePath: "reports/proof.html",
            mimeType: "text/html",
            diff: "@@ -1 +1 @@\n-<p>old</p>\n+<p>new</p>\n",
          }),
        ]}
      />
    </TestRouter>,
  )

  const viewer = within(screen.getByRole("region", { name: /artifact viewer/i }))
  // The diff is what changed, so it stays the landing view even for a renderable file.
  expect(viewer.getByText("+<p>new</p>")).toBeInTheDocument()
  expect(viewer.queryByTitle(/rendered preview/i)).not.toBeInTheDocument()

  await user.click(viewer.getByRole("tab", { name: /preview/i }))

  expect(viewer.getByTitle(/rendered preview/i)).toHaveAttribute(
    "src",
    "/api/artifacts/c-html/raw?which=current",
  )
})

test("S48: a binary captured artifact points its media at the raw route rather than a data url", () => {
  render(
    <TestRouter initialEntries={["/s/1?tab=artifacts"]}>
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
      />
    </TestRouter>,
  )

  const image = screen.getByRole("img", { name: /architecture\.png/ })
  expect(image).toHaveAttribute("src", "/api/artifacts/c-img/raw?which=current")
})

test("S53: transcript frame-link artifacts and captured files both appear in the tree", () => {
  render(
    <TestRouter initialEntries={["/s/1?tab=artifacts"]}>
      <ArtifactsView
        artifacts={[captured({ id: "c-1", relativePath: "docs/notes.md" }), ...ARTIFACTS]}
      />
    </TestRouter>,
  )

  const list = screen.getByRole("list", { name: /filed artifacts/i })
  const rows = within(list)
    .getAllByRole("button")
    .map((button) => button.textContent ?? "")

  // Both sources are in one tree, filed under their own folders rather than in two flat blocks.
  expect(rows.some((row) => row.includes("notes.md"))).toBe(true)
  expect(rows.some((row) => row.includes("idempotency-design.md"))).toBe(true)
  expect(rows.some((row) => row.includes("0007_add_source_uid.sql"))).toBe(true)
  expect(rows.filter((row) => row === "docs")).toHaveLength(1)
  expect(rows.some((row) => row === "migrations")).toBe(true)
})
