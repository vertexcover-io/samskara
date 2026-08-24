import { useMemo, useState } from "react"
import type { ToolEvidence } from "./records.js"
import { ToolCallItem } from "./ToolCallItem.js"

const failures = (calls: ReadonlyArray<ToolEvidence>): number =>
  calls.filter((call) => call.status === "failure").length

type Props = {
  readonly calls: ReadonlyArray<ToolEvidence>
  readonly agentOf?: (call: ToolEvidence) => string | null
}

export const ToolCallsView = ({ calls, agentOf }: Props) => {
  const [tool, setTool] = useState<string>("")

  const names = useMemo(() => {
    const counts = new Map<string, number>()
    for (const call of calls) counts.set(call.toolName, (counts.get(call.toolName) ?? 0) + 1)
    return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  }, [calls])

  const shown = tool === "" ? calls : calls.filter((call) => call.toolName === tool)

  if (calls.length === 0) {
    return (
      <p className="border border-dashed border-rule bg-panel p-6 text-center text-ink-soft">
        This session recorded no tool calls.
      </p>
    )
  }

  return (
    <div className="max-w-[1200px]">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3 border-b border-rule pb-3">
        <div>
          <h2 className="text-[0.9375rem] font-semibold">Tool calls</h2>
          <p className="max-w-[72ch] text-ink-soft">
            Inputs and captured outputs, grouped as individual procedures.
          </p>
        </div>
        <p className="font-mono text-[0.6875rem] text-faded">
          {shown.length} of {calls.length} {calls.length === 1 ? "call" : "calls"} ·{" "}
          {failures(shown)} failed
        </p>
      </div>

      <div className="mb-3 flex flex-wrap gap-1.5">
        <button
          type="button"
          aria-pressed={tool === ""}
          onClick={() => setTool("")}
          className={`rounded-pill border px-3 py-1 font-mono text-[0.6875rem] transition-colors ${
            tool === "" ? "border-ink bg-ink text-panel-2" : "border-rule hover:border-ink-soft"
          }`}
        >
          All {calls.length}
        </button>
        {names.map(([name, count]) => (
          <button
            key={name}
            type="button"
            aria-pressed={tool === name}
            onClick={() => setTool(name)}
            className={`rounded-pill border px-3 py-1 font-mono text-[0.6875rem] transition-colors ${
              tool === name ? "border-ink bg-ink text-panel-2" : "border-rule hover:border-ink-soft"
            }`}
          >
            {name} {count}
          </button>
        ))}
      </div>

      {/* min-w-0 on both the track and the item: grid children default to
          min-width:auto and would otherwise stretch to their widest content. */}
      <ul className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2">
        {shown.map((call) => (
          <li key={`${call.messageId}:${call.toolId}`} className="min-w-0">
            <ToolCallItem call={call} agent={agentOf?.(call) ?? null} />
          </li>
        ))}
      </ul>
    </div>
  )
}
