import type { RawSubagent } from "../api/types.js"
import { RecordItem } from "./RecordItem.js"
import { SubagentAnnex } from "./SubagentAnnex.js"
import type { TimelineRecord } from "./records.js"

type Props = {
  readonly records: ReadonlyArray<TimelineRecord>
  readonly branches: ReadonlyMap<string, ReadonlyArray<TimelineRecord>>
  readonly showTools: boolean
  readonly spine: boolean
  readonly focusedId: string | null
  readonly onOpen: (id: string, trigger: HTMLElement) => void
  readonly onExit: () => void
}

const annexFor = (
  agent: RawSubagent,
  props: Props,
): { readonly records: ReadonlyArray<TimelineRecord>; readonly open: boolean } => ({
  records: props.branches.get(agent.agentId) ?? [],
  open: props.focusedId === agent.agentId,
})

const dimmed = (record: TimelineRecord, focusedId: string | null): boolean => {
  if (focusedId === null) return false
  return !(record.kind === "agentSpawn" && record.agent.agentId === focusedId)
}

export const RecordStream = (props: Props) => {
  const { records, showTools, spine, focusedId, onOpen, onExit } = props

  if (records.length === 0) {
    return (
      <p className="border border-dashed border-rule bg-panel p-6 text-center text-ink-soft">
        No records of this kind were captured for this session.
      </p>
    )
  }

  return (
    <ol
      className={
        spine
          ? "relative pl-8 before:absolute before:bottom-3 before:left-2.5 before:top-3 before:w-px before:bg-custody"
          : "relative"
      }
    >
      {records.map((record) => (
        <li
          key={record.id}
          className={`relative border-rule-soft [&+&]:border-t ${
            dimmed(record, focusedId) ? "opacity-30 saturate-50" : ""
          } ${
            spine
              ? "before:absolute before:-left-[1.4rem] before:top-[1.35rem] before:size-1.5 before:rounded-pill before:border before:border-custody before:bg-paper"
              : ""
          }`}
        >
          <RecordItem
            record={record}
            showTools={showTools}
            annex={
              record.kind === "agentSpawn" ? (
                <SubagentAnnex
                  agent={record.agent}
                  showTools={showTools}
                  onOpen={onOpen}
                  onExit={onExit}
                  {...annexFor(record.agent, props)}
                />
              ) : undefined
            }
          />
        </li>
      ))}
    </ol>
  )
}
