import { useEffect, useState } from "react"
import { codeToHtml } from "shiki"

/**
 * Extension -> shiki language id. Only grammars worth loading for what an agent actually writes;
 * an unmapped extension returns null and renders as plain text rather than guessing, since a wrong
 * grammar colours the file misleadingly instead of failing visibly.
 */
const LANGUAGES: Readonly<Record<string, string>> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  py: "python",
  go: "go",
  rs: "rust",
  rb: "ruby",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cpp: "cpp",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  json: "json",
  jsonc: "jsonc",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  xml: "xml",
  html: "html",
  css: "css",
  scss: "scss",
  sql: "sql",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  fish: "shell",
  dockerfile: "docker",
  graphql: "graphql",
  prisma: "prisma",
}

const FILENAMES: Readonly<Record<string, string>> = {
  dockerfile: "docker",
  makefile: "make",
}

export const languageForPath = (path: string): string | null => {
  const name = (path.split("/").pop() ?? "").toLowerCase()
  const byName = FILENAMES[name]
  if (byName) return byName
  if (!name.includes(".")) return null
  return LANGUAGES[name.split(".").pop() ?? ""] ?? null
}

// Matches the muted paper palette in index.css; a dark editor theme would fight the surrounding UI.
const THEME = "github-light"

type Props = {
  readonly source: string
  /** The file the source came from; its extension picks the grammar. */
  readonly path: string | null
  /** Declared directly by a markdown fence, where there is no path to infer from. */
  readonly language?: string
  /** Wraps long lines instead of scrolling them sideways. */
  readonly wrap?: boolean
}

/**
 * Highlighting is async because shiki loads its grammar and theme on demand. The raw source renders
 * immediately and is replaced once tokenised, so a large file is readable rather than blank while
 * it loads -- and a grammar that fails to load leaves the file readable instead of empty.
 */
export const Code = ({ source, path, language: declared, wrap = false }: Props) => {
  const language = declared ?? (path === null ? null : languageForPath(path))
  const [html, setHtml] = useState<string | null>(null)
  const flow = wrap ? "artifact-wrap" : "overflow-x-auto"

  useEffect(() => {
    if (language === null) return
    let live = true
    codeToHtml(source, { lang: language, theme: THEME })
      .then((result) => {
        if (live) setHtml(result)
      })
      .catch(() => {
        // An unknown grammar or a failed chunk load: keep the plain-text fallback already on screen.
      })
    return () => {
      live = false
    }
  }, [source, language])

  if (html !== null) {
    return (
      <div
        className={`artifact-code ${flow} bg-panel p-3 text-[0.72rem] leading-relaxed ${path === null ? "" : "border border-rule"}`}
        // biome-ignore lint/security/noDangerouslySetInnerHtml: shiki emits escaped, tokenised markup
        dangerouslySetInnerHTML={{ __html: html }}
      />
    )
  }

  return (
    <pre
      className={`${wrap ? "whitespace-pre-wrap break-words" : "overflow-x-auto"} bg-panel p-3 font-mono text-[0.72rem] leading-relaxed ${path === null ? "" : "border border-rule"}`}
    >
      {source}
    </pre>
  )
}
