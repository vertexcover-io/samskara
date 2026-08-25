import { unzipSync } from "fflate"
import { expect, test } from "vitest"
import { fileNameOf, uniquePaths, zipArtifacts } from "./artifact-download.js"

const artifact = (id: string, relativePath: string | null) => ({ id, relativePath, label: null })

test("a file keeps its own name, falling back through label to id", () => {
  expect(fileNameOf(artifact("a", "src/watcher/driver.ts"))).toBe("driver.ts")
  expect(fileNameOf(artifact("b", "notes.md"))).toBe("notes.md")
  expect(fileNameOf({ id: "c", relativePath: null, label: "docs/plan.md" })).toBe("plan.md")
  expect(fileNameOf({ id: "d", relativePath: null, label: null })).toBe("d")
})

test("colliding paths are suffixed so no artifact is silently replaced in the archive", () => {
  const paths = uniquePaths([
    artifact("a", "docs/notes.md"),
    artifact("b", "docs/notes.md"),
    artifact("c", "docs/notes.md"),
    artifact("d", "README"),
    artifact("e", "README"),
  ])

  expect(paths.get("a")).toBe("docs/notes.md")
  expect(paths.get("b")).toBe("docs/notes-2.md")
  expect(paths.get("c")).toBe("docs/notes-3.md")
  // No extension to preserve, so the suffix goes on the end.
  expect(paths.get("d")).toBe("README")
  expect(paths.get("e")).toBe("README-2")
  expect(new Set(paths.values()).size).toBe(5)
})

test("the archive preserves directory structure and every artifact's bytes", async () => {
  const bodies: Readonly<Record<string, string>> = {
    a: "export const one = 1\n",
    b: "# Notes\n\nbody\n",
  }
  const blob = await zipArtifacts(
    [artifact("a", "src/one.ts"), artifact("b", "docs/notes.md")],
    async (id) => new TextEncoder().encode(bodies[id] ?? ""),
  )

  const unzipped = unzipSync(new Uint8Array(await blob.arrayBuffer()))
  expect(Object.keys(unzipped).sort()).toEqual(["docs/notes.md", "src/one.ts"])
  expect(new TextDecoder().decode(unzipped["src/one.ts"])).toBe(bodies.a)
  expect(new TextDecoder().decode(unzipped["docs/notes.md"])).toBe(bodies.b)
})

test("one unreadable artifact does not lose the rest of the archive", async () => {
  const blob = await zipArtifacts(
    [artifact("ok", "good.ts"), artifact("gone", "missing.ts")],
    async (id) => {
      if (id === "gone") throw new Error("403")
      return new TextEncoder().encode("kept\n")
    },
  )

  const unzipped = unzipSync(new Uint8Array(await blob.arrayBuffer()))
  expect(Object.keys(unzipped)).toEqual(["good.ts"])
})
