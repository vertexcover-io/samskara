import { RecordItem } from "./RecordItem.js"
import { type AnnexContext, annexFor } from "./SubagentAnnex.js"
import { type TimelineRecord, anchorOf } from "./records.js"

type Props = AnnexContext & {
  readonly records: ReadonlyArray<TimelineRecord>
  readonly spine: boolean
}

// Focus mode leaves the ancestry of the open branch lit and dims the rest, so a nested branch
// stays visible through the annexes that contain it.
const dimmed = (record: TimelineRecord, openIds: ReadonlySet<string>): boolean => {
  if (openIds.size === 0) return false
  return !(record.kind === "agentSpawn" && openIds.has(record.agent.agentId))
}

export const RecordStream = ({ records, spine, ...context }: Props) => {
  const { openIds, showTools, linkFor, linkedAnchor } = context

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
            dimmed(record, openIds) ? "opacity-30 saturate-50" : ""
          } ${
            spine
              ? "before:absolute before:-left-[1.4rem] before:top-[1.35rem] before:size-1.5 before:rounded-pill before:border before:border-custody before:bg-paper"
              : ""
          }`}
        >
          <RecordItem
            record={record}
            showTools={showTools}
            link={linkFor(record)}
            linked={anchorOf(record) === linkedAnchor}
            annex={annexFor(record, context)}
          />
        </li>
      ))}
    </ol>
  )
}
