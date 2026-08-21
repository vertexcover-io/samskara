import type { RawSubagent } from "../api/shapes.js"
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
  readonly kind: string | null
  readonly lane: string
  readonly messages: number
  readonly toolCalls: number
  readonly durationMs: number | null
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

  // Branches usually share one agentType, so the task it was given is what names a branch; the
  // type is the fallback only when the capture recorded no description.
  return [
    {
      id: null,
      name: "Claude",
      kind: null,
      lane: "var(--color-custody)",
      messages: main.messages,
      toolCalls: main.toolCalls,
      durationMs: main.durationMs,
    },
    ...agents.map((agent, index) => {
      const counts = countsOf(branches.get(agent.agentId) ?? [])
      return {
        id: agent.agentId,
        name: agent.description ?? agent.agentType ?? agent.agentId,
        kind: agent.description === null ? null : agent.agentType,
        lane: laneFor(index),
        messages: counts.messages,
        toolCalls: counts.toolCalls,
        durationMs: counts.durationMs,
      }
    }),
  ]
}

type Props = {
  readonly entries: ReadonlyArray<AgentEntry>
  readonly selectedId: string | null
  readonly onSelect: (id: string | null) => void
}

export const AgentRail = ({ entries, selectedId, onSelect }: Props) => (
  <aside
    aria-label="Agents in this session"
    // `--sticky-head` is the height of the pinned title and tab bars, published by the session
    // route. Parking under it is what keeps the first agent visible rather than behind them.
    className="min-w-0 min-[900px]:sticky min-[900px]:top-[calc(var(--sticky-head,0px)_+_1rem)] min-[900px]:max-h-[calc(100dvh_-_var(--sticky-head,0px)_-_2rem)] min-[900px]:self-start min-[900px]:overflow-y-auto min-[900px]:pr-1"
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
            <span className="flex min-w-0 items-start gap-2 text-[0.78rem] font-semibold">
              <span
                aria-hidden="true"
                className="mt-1 size-2.5 shrink-0 rounded-xs"
                style={{ background: entry.lane }}
              />
              <span className="min-w-0">
                <span className="block leading-snug">{entry.name}</span>
                {entry.kind === null ? null : (
                  <span className="mt-0.5 block truncate font-mono text-[0.6875rem] font-normal text-faded">
                    {entry.kind}
                  </span>
                )}
              </span>
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
