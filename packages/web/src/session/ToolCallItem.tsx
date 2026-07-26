import { useState } from "react"
import type { ToolEvidence } from "./records.js"

const OUTCOME_LABEL: Readonly<Record<string, string>> = {
  success: "Cleared",
  failure: "Failed",
  cancelled: "Cancelled",
  unknown: "Unknown",
}

const outcomeClass = (status: string | null): string =>
  status === "failure" ? "text-err" : status === null ? "text-faded" : "text-ok"

export const summarize = (value: unknown): string => {
  if (value === null || value === undefined) return "no payload captured"
  if (typeof value === "string") return value
  return JSON.stringify(value, null, 2)
}

const Payload = ({ label, value }: { label: string; value: unknown }) => (
  <div className="border-t border-rule px-3 py-2">
    <p className="text-[0.656rem] font-semibold uppercase tracking-[0.12em] text-faded">{label}</p>
    <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-words font-mono text-[0.72rem] text-ink-2">
      {summarize(value)}
    </pre>
  </div>
)

export const ToolCallItem = ({ call }: { call: ToolEvidence }) => {
  const [open, setOpen] = useState(false)
  const status = call.status
  const label = status === null ? "Pending" : (OUTCOME_LABEL[status] ?? status)

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
        <span className="min-w-0 flex-1 truncate font-mono text-[0.72rem] text-faded">
          {summarize(call.toolInput)}
        </span>
        <span
          className={`shrink-0 text-[0.656rem] font-semibold uppercase tracking-[0.12em] ${outcomeClass(status)}`}
        >
          {label}
        </span>
      </button>

      {open ? (
        <>
          <Payload label="Input" value={call.toolInput} />
          <Payload label="Output" value={call.result} />
        </>
      ) : null}
    </div>
  )
}
