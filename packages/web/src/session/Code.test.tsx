import { render, screen, waitFor } from "@testing-library/react"
import { expect, test } from "vitest"
import { Code, languageForPath } from "./Code.js"

test("languageForPath maps the extensions the capture actually produces", () => {
  const cases: ReadonlyArray<readonly [string, string | null]> = [
    ["src/watcher/driver.ts", "typescript"],
    ["src/App.tsx", "tsx"],
    ["scripts/build.js", "javascript"],
    ["src/main.jsx", "jsx"],
    ["api/handler.py", "python"],
    ["cmd/main.go", "go"],
    ["src/lib.rs", "rust"],
    ["package.json", "json"],
    ["compose.yml", "yaml"],
    ["schema.sql", "sql"],
    ["run.sh", "shell"],
    ["Dockerfile", "docker"],
    // Unmapped extensions must render as plain text rather than guessing a grammar.
    ["notes.xyz", null],
    ["LICENSE", null],
  ]

  for (const [path, expected] of cases) {
    expect(languageForPath(path), path).toBe(expected)
  }
})

test("a source file is highlighted, and its text survives tokenisation intact", async () => {
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal source text being highlighted, not a real template literal
  const source = "const greet = (name: string): string => `hi ${name}`\n"
  render(<Code source={source} path="src/greet.ts" />)

  // Before highlighting resolves the raw source is already on screen, so the pane is never blank.
  expect(screen.getByText(/const greet/)).toBeInTheDocument()

  await waitFor(() => {
    const highlighted = document.querySelector("pre.shiki")
    expect(highlighted).not.toBeNull()
  })

  // Tokenisation must not drop or reorder characters -- the whole point is that this is the file.
  const rendered = document.querySelector("pre.shiki")?.textContent ?? ""
  expect(rendered.trim()).toBe(source.trim())
  // At least one token carried a colour, otherwise this is a <pre> wearing a class name.
  expect(document.querySelector("pre.shiki span[style]")).not.toBeNull()
})

test("an unmapped extension renders as readable plain text rather than failing", async () => {
  const source = "just some words\nacross two lines\n"
  render(<Code source={source} path="notes.xyz" />)

  expect(screen.getByText(/just some words/)).toBeInTheDocument()

  // No grammar to apply, so it must settle as plain text and never surface an error.
  await waitFor(() => {
    expect(screen.getByText(/across two lines/)).toBeInTheDocument()
  })
})
