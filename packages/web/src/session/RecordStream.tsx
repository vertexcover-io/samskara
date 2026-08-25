import { RecordItem, SPINE_DOT, toneOf } from "./RecordItem.js"
import { anchorOf, type TimelineRecord } from "./records.js"
import { type AnnexContext, annexFor } from "./SubagentAnnex.js"

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
    // The spine runs down the gutter's centre at 16px: a 2px line from 15px, and a 10px node from
    // 11px. `calc(-2rem + 11px)` cancels the list's own padding, so the node keeps its place if the
    // gutter changes. Both marks are sized in px, not rem -- the root font scales on wide viewports,
    // and a rem-sized node drifts off a px-positioned line.
    <ol
      className={
        spine
          ? "relative pl-8 before:absolute before:bottom-3 before:left-[15px] before:top-3 before:w-[2px] before:bg-rule"
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
              ? `before:absolute before:left-[calc(-2rem_+_11px)] before:top-[1.3rem] before:z-10 before:size-[10px] before:rounded-pill before:border-2 ${SPINE_DOT[toneOf(record)]}`
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
