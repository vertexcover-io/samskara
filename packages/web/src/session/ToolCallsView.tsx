import { ToolCallItem } from "./ToolCallItem.js"
import type { ToolEvidence } from "./records.js"

const failures = (calls: ReadonlyArray<ToolEvidence>): number =>
  calls.filter((call) => call.status === "failure").length

export const ToolCallsView = ({ calls }: { calls: ReadonlyArray<ToolEvidence> }) => {
  if (calls.length === 0) {
    return (
      <p className="border border-dashed border-rule bg-panel p-6 text-center text-ink-soft">
        This session recorded no tool calls.
      </p>
    )
  }

  return (
    <div className="max-w-[900px]">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3 border-b border-rule pb-3">
        <div>
          <h2 className="text-[0.9375rem] font-semibold">Tool calls</h2>
          <p className="max-w-[72ch] text-ink-soft">
            Inputs and captured outputs, grouped as individual procedures.
          </p>
        </div>
        <p className="font-mono text-[0.6875rem] text-faded">
          {calls.length} {calls.length === 1 ? "call" : "calls"} · {failures(calls)} failed
        </p>
      </div>

      <ul className="grid gap-2">
        {calls.map((call) => (
          <li key={`${call.messageId}:${call.toolId}`}>
            <ToolCallItem call={call} />
          </li>
        ))}
      </ul>
    </div>
  )
}
