import type { RawSubagent } from "../api/types.js"
import type { TimelineRecord } from "./records.js"

const LANES = [
  "var(--color-agent-audit)",
  "var(--color-agent-test)",
  "var(--color-agent-perf)",
] as const

export const laneFor = (index: number): string => LANES[index % LANES.length] ?? LANES[0]

export type AgentEntry = {
  readonly id: string | null
  readonly name: string
  readonly description: string | null
  readonly lane: string
  readonly messages: number
  readonly toolCalls: number
  readonly durationMs: number | null
  readonly status: "completed" | "interrupted"
}

export const formatSpan = (ms: number): string => {
  const totalMinutes = Math.round(ms / 60_000)
  if (totalMinutes < 1) return `${Math.max(1, Math.round(ms / 1000))}s`
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (hours === 0) return `${minutes}m`
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`
}

export const spanOf = (records: ReadonlyArray<TimelineRecord>): number | null => {
  const times = records
    .map((record) =>
      record.timestamp === null ? Number.NaN : new Date(record.timestamp).getTime(),
    )
    .filter((time) => !Number.isNaN(time))
  if (times.length < 2) return null
  return Math.max(...times) - Math.min(...times)
}

const countsOf = (records: ReadonlyArray<TimelineRecord>) => {
  let messages = 0
  let toolCalls = 0
  for (const record of records) {
    if (record.kind === "tool") toolCalls += record.calls.length
    else if (record.kind === "assistant" || record.kind === "prompt") messages += 1
  }
  return { messages, toolCalls, durationMs: spanOf(records) }
}

export const agentEntries = (
  records: ReadonlyArray<TimelineRecord>,
  agents: ReadonlyArray<RawSubagent>,
  branches: ReadonlyMap<string, ReadonlyArray<TimelineRecord>>,
): ReadonlyArray<AgentEntry> => {
  const main = countsOf(records)
  const returned = new Set(
    records.flatMap((record) => (record.kind === "agentReturn" ? [record.agent.agentId] : [])),
  )

  return [
    {
      id: null,
      name: "Claude",
      description: null,
      lane: "var(--color-custody)",
      messages: main.messages,
      toolCalls: main.toolCalls,
      durationMs: main.durationMs,
      status: "completed" as const,
    },
    ...agents.map((agent, index) => {
      const branch = branches.get(agent.agentId) ?? []
      const counts = countsOf(branch)
      return {
        id: agent.agentId,
        name: agent.agentType ?? agent.agentId,
        description: agent.description,
        lane: laneFor(index),
        messages: counts.messages,
        toolCalls: counts.toolCalls,
        durationMs: counts.durationMs,
        status: returned.has(agent.agentId) ? ("completed" as const) : ("interrupted" as const),
      }
    }),
  ]
}

const STATUS_LABEL: Readonly<Record<AgentEntry["status"], string>> = {
  completed: "Done",
  interrupted: "Interrupted",
}

const statusClass = (status: AgentEntry["status"]): string =>
  status === "completed" ? "text-ok" : "text-warn"

type Props = {
  readonly entries: ReadonlyArray<AgentEntry>
  readonly selectedId: string | null
  readonly onSelect: (id: string | null) => void
}

export const AgentRail = ({ entries, selectedId, onSelect }: Props) => (
  <aside
    aria-label="Agents in this session"
    className="min-w-0 min-[900px]:sticky min-[900px]:top-4 min-[900px]:max-h-[calc(100dvh-2rem)] min-[900px]:self-start min-[900px]:overflow-y-auto min-[900px]:pr-1"
  >
    <h2 className="text-[0.656rem] font-semibold uppercase tracking-[0.12em] text-faded">
      Agents · {entries.length}
    </h2>

    <div className="mt-2 grid gap-2 min-[900px]:block">
      {entries.map((entry) => {
        const active = entry.id === selectedId
        return (
          <button
            key={entry.id ?? "main"}
            type="button"
            aria-current={active}
            onClick={() => onSelect(entry.id)}
            style={{ boxShadow: active ? `inset 3px 0 0 ${entry.lane}` : undefined }}
            className={`mb-2 block w-full rounded-xs border bg-panel px-3 py-2.5 text-left transition-colors hover:border-ink-soft ${
              active ? "border-ink" : "border-rule"
            }`}
          >
            <span className="flex items-center justify-between gap-2">
              <span className="flex min-w-0 items-center gap-2 text-[0.78rem] font-semibold">
                <span
                  aria-hidden="true"
                  className="size-2.5 shrink-0 rounded-xs"
                  style={{ background: entry.lane }}
                />
                <span className="truncate">{entry.name}</span>
              </span>
              {entry.id === null ? null : (
                <span
                  className={`shrink-0 text-[0.625rem] font-semibold uppercase tracking-[0.1em] ${statusClass(entry.status)}`}
                >
                  {STATUS_LABEL[entry.status]}
                </span>
              )}
            </span>
            <span className="mt-1.5 flex flex-wrap gap-x-3 font-mono text-[0.6875rem] text-ink-soft">
              <span>{entry.messages} msg</span>
              <span>{entry.toolCalls} tools</span>
              {entry.durationMs === null ? null : <span>{formatSpan(entry.durationMs)}</span>}
            </span>
          </button>
        )
      })}
    </div>

    <p className="mt-2 border-t border-dashed border-rule pt-2 text-[0.6875rem] text-faded">
      {selectedId === null
        ? "Showing the main record. Choose a branch to inspect it on its own."
        : "Showing one branch. Choose Claude to return to the main record."}
    </p>
  </aside>
)
