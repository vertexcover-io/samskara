import { useState } from "react"
import { Markdown } from "./Markdown.js"
import type { ToolEvidence } from "./records.js"

const OUTCOME_LABEL: Readonly<Record<string, string>> = {
  success: "Cleared",
  failure: "Failed",
  cancelled: "Cancelled",
  unknown: "Unknown",
}

const outcomeClass = (status: string | null): string =>
  status === "failure" ? "text-err" : status === null ? "text-faded" : "text-ok"

const MARKDOWN_HINT = /^#{1,6}\s|^\s*[-*]\s+\S|```|\|.*\|/m

const looksMarkdown = (value: unknown): value is string =>
  typeof value === "string" && MARKDOWN_HINT.test(value)

// A flat object reads far better as labelled fields than as a JSON blob.
const asFields = (value: unknown): ReadonlyArray<readonly [string, unknown]> | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null
  const entries = Object.entries(value)
  return entries.length === 0 || entries.length > 12 ? null : entries
}

const scalar = (value: unknown): string => {
  if (typeof value === "string") return value
  if (value === null) return "null"
  return JSON.stringify(value, null, 2)
}

const EXTENSION_LANGUAGE: Readonly<Record<string, string>> = {
  ts: "ts",
  tsx: "tsx",
  js: "js",
  jsx: "jsx",
  py: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  sql: "sql",
  sh: "bash",
  bash: "bash",
  json: "json",
  yml: "yaml",
  yaml: "yaml",
  css: "css",
  html: "html",
  md: "markdown",
}

const languageForPath = (path: unknown): string | null => {
  if (typeof path !== "string") return null
  const name = path.split("/").pop() ?? ""
  if (!name.includes(".")) return null
  return EXTENSION_LANGUAGE[(name.split(".").pop() ?? "").toLowerCase()] ?? null
}

const Scalar = ({ value, language }: { value: unknown; language?: string | null }) => {
  const text = scalar(value)
  const multiline = text.includes("\n")

  // Reuse the conversation renderer so fenced code, tables, and mermaid in tool
  // payloads look the same as they do in the transcript.
  if (multiline && language !== null && language !== undefined) {
    return <Markdown source={`\`\`\`${language}\n${text}\n\`\`\``} />
  }
  if (looksMarkdown(value)) return <Markdown source={value} />

  return (
    <pre
      className={`min-w-0 overflow-x-auto whitespace-pre-wrap break-words font-mono text-[0.72rem] text-ink-2 ${
        multiline ? "rounded-xs border border-rule bg-panel p-2" : ""
      }`}
    >
      {text}
    </pre>
  )
}

const CODE_KEYS = new Set(["content", "new_string", "old_string", "code", "text"])

const Fields = ({
  entries,
  language,
}: { entries: ReadonlyArray<readonly [string, unknown]>; language: string | null }) => (
  <dl className="mt-1 grid min-w-0 gap-1.5">
    {entries.map(([key, value]) => (
      <div key={key} className="grid min-w-0 gap-0.5 min-[560px]:grid-cols-[10rem_minmax(0,1fr)]">
        <dt className="font-mono text-[0.6875rem] font-semibold text-custody">{key}</dt>
        <dd className="min-w-0">
          <Scalar value={value} language={CODE_KEYS.has(key) ? language : null} />
        </dd>
      </div>
    ))}
  </dl>
)

const Payload = ({
  label,
  value,
  language,
}: { label: string; value: unknown; language: string | null }) => {
  const entries = asFields(value)

  return (
    <div className="min-w-0 border-t border-rule px-3 py-2">
      <p className="text-[0.656rem] font-semibold uppercase tracking-[0.12em] text-faded">
        {label}
      </p>
      {value === null || value === undefined ? (
        <p className="mt-1 text-[0.72rem] italic text-faded">no payload captured</p>
      ) : entries ? (
        <Fields entries={entries} language={language} />
      ) : (
        <div className="mt-1 min-w-0">
          <Scalar value={value} language={language} />
        </div>
      )}
    </div>
  )
}

// Status must not rely on colour alone.
const OUTCOME_GLYPH: Readonly<Record<string, string>> = {
  success: "✓",
  failure: "✕",
  cancelled: "⊘",
  unknown: "?",
}

// A one-line gist of the input beats a JSON dump in the collapsed header.
const gistOf = (value: unknown): string => {
  if (typeof value === "string") return value.split("\n")[0] ?? ""
  const entries = asFields(value)
  if (entries === null) return value === null || value === undefined ? "" : scalar(value)
  return entries.map(([key, item]) => `${key}: ${scalar(item).split("\n")[0]}`).join("  ·  ")
}

const pathOf = (value: unknown): unknown => {
  const entries = asFields(value)
  if (entries === null) return null
  const found = entries.find(
    ([key]) => key === "file_path" || key === "path" || key === "notebook_path",
  )
  return found?.[1] ?? null
}

export const ToolCallItem = ({
  call,
  agent = null,
}: { call: ToolEvidence; agent?: string | null }) => {
  const [open, setOpen] = useState(false)
  const status = call.status
  const label = status === null ? "Pending" : (OUTCOME_LABEL[status] ?? status)
  const language = languageForPath(pathOf(call.toolInput))

  return (
    <div className="max-w-full overflow-hidden rounded-xs border border-rule bg-panel-2">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        className="flex min-h-10 w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-panel"
      >
        <span aria-hidden="true" className="font-mono text-ink-soft">
          {open ? "⌄" : "›"}
        </span>
        <span className="shrink-0 font-mono text-[0.75rem] font-semibold">{call.toolName}</span>
        {agent === null ? null : (
          <span className="shrink-0 rounded-pill border border-custody px-2 py-0.5 font-mono text-[0.625rem] text-custody">
            {agent}
          </span>
        )}
        <span className="min-w-0 flex-1 truncate font-mono text-[0.72rem] text-faded">
          {gistOf(call.toolInput)}
        </span>
        <span
          className={`shrink-0 text-[0.656rem] font-semibold uppercase tracking-[0.12em] ${outcomeClass(status)}`}
        >
          <span aria-hidden="true">{status === null ? "·" : (OUTCOME_GLYPH[status] ?? "·")}</span>{" "}
          {label}
        </span>
      </button>

      {open ? (
        <>
          <Payload label="Input" value={call.toolInput} language={language} />
          <Payload label="Output" value={call.result} language={language} />
        </>
      ) : null}
    </div>
  )
}
