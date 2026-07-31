import { expect, test } from "vitest"
import { buildTree, countByKind, folderPaths, kindOfPath, matchesKind } from "./artifact-filter.js"

test("files are grouped by what a reader scans for, not by mime family", () => {
  const cases: ReadonlyArray<readonly [string | null, boolean, string]> = [
    ["src/watcher/driver.ts", false, "code"],
    ["packages/web/App.tsx", false, "code"],
    ["scripts/run.sh", false, "code"],
    ["package.json", false, "code"],
    ["docs/design.md", false, "docs"],
    ["notes.txt", false, "docs"],
    ["report.pdf", true, "docs"],
    // A diff is prose about code, so it reads with the docs rather than the sources.
    ["patches/fix.diff", false, "docs"],
    ["docs/architecture.svg", false, "media"],
    ["shots/screen.png", true, "media"],
    ["clips/walkthrough.mp4", true, "media"],
    // Unknown extension: text falls to code (what agents mostly write), binary to media.
    ["Makefile", false, "code"],
    ["build/output.bin", true, "media"],
    [null, false, "code"],
  ]

  for (const [path, isBinary, expected] of cases) {
    expect(kindOfPath(path, isBinary), `${path}`).toBe(expected)
  }
})

test("the all filter keeps everything and the counts sum to it", () => {
  const artifacts = [
    { relativePath: "src/a.ts", label: null, isBinary: false },
    { relativePath: "src/b.tsx", label: null, isBinary: false },
    { relativePath: "docs/c.md", label: null, isBinary: false },
    { relativePath: "img/d.png", label: null, isBinary: true },
  ]

  expect(artifacts.every((a) => matchesKind(a, "all"))).toBe(true)

  const counts = countByKind(artifacts)
  expect(counts).toEqual({ all: 4, code: 2, docs: 1, media: 1 })
  // Every artifact lands in exactly one bucket, so nothing can be hidden by every filter at once.
  expect(counts.code + counts.docs + counts.media).toBe(counts.all)
})

test("a label is used when no relativePath exists, so frame-link artifacts still filter", () => {
  const frameLink = { relativePath: null, label: "docs/plan.md", isBinary: false }

  expect(matchesKind(frameLink, "docs")).toBe(true)
  expect(matchesKind(frameLink, "code")).toBe(false)
})

test("the tree nests folders, sorts folders before files, and collapses single-child chains", () => {
  const tree = buildTree([
    { relativePath: "packages/cli/src/driver.ts", label: null },
    { relativePath: "README.md", label: null },
    { relativePath: "packages/cli/src/artifact.ts", label: null },
    { relativePath: "packages/web/App.tsx", label: null },
    { relativePath: null, label: "docs/plan.md" },
  ])

  // Folders first (docs, packages), then root-level files (README.md).
  expect(tree.map((n) => `${n.kind}:${n.name}`)).toEqual([
    "folder:docs",
    "folder:packages",
    "file:README.md",
  ])

  // `docs` holds one file, so it does not collapse into anything.
  const docs = tree[0]
  expect(docs?.kind === "folder" && docs.children.map((c) => c.name)).toEqual(["plan.md"])

  // `packages/cli` holds only `src`, which collapses into a single `cli/src` row.
  const packages = tree[1]
  const inner = packages?.kind === "folder" ? packages.children : []
  expect(inner.map((n) => n.name)).toEqual(["cli/src", "web"])
  const cliSrc = inner[0]
  expect(cliSrc?.kind === "folder" && cliSrc.children.map((c) => c.name)).toEqual([
    "artifact.ts",
    "driver.ts",
  ])
  expect(cliSrc?.kind === "folder" && cliSrc.path).toBe("packages/cli/src")
})

test("folderPaths lists every folder so the browser can open expanded", () => {
  const tree = buildTree([
    { relativePath: "a/b/one.ts", label: null },
    { relativePath: "c/two.ts", label: null },
  ])

  expect([...folderPaths(tree)].sort()).toEqual(["a/b", "c"])
})
