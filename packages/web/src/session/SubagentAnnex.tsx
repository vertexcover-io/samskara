import type { ReactNode } from "react"
import type { RawSubagent } from "../api/shapes.js"
import { formatSpan, spanOf } from "./AgentRail.js"
import { RecordItem } from "./RecordItem.js"
import { type TimelineRecord, anchorOf } from "./records.js"

/**
 * Everything an annex needs to draw the branches nested inside it. A subagent can spawn its own
 * subagents, so an annex renders annexes; this context is what recurses.
 */
export type AnnexContext = {
  readonly branches: ReadonlyMap<string, ReadonlyArray<TimelineRecord>>
  readonly openIds: ReadonlySet<string>
  readonly onOpen: (id: string, trigger: HTMLElement) => void
  readonly onExit: () => void
  readonly showTools: boolean
  readonly linkFor: (record: TimelineRecord) => string | undefined
  readonly linkedAnchor: string | null
}

type Props = AnnexContext & { readonly agent: RawSubagent }

const nameOf = (agent: RawSubagent): string => agent.agentType ?? agent.agentId

export const annexFor = (record: TimelineRecord, context: AnnexContext): ReactNode =>
  record.kind === "agentSpawn" ? <SubagentAnnex agent={record.agent} {...context} /> : undefined

export const SubagentAnnex = ({ agent, ...context }: Props) => {
  const { branches, openIds, onOpen, onExit, showTools, linkFor, linkedAnchor } = context
  const records = branches.get(agent.agentId) ?? []
  const open = openIds.has(agent.agentId)
  const name = nameOf(agent)
  const span = spanOf(records)
  const branchId = `annex-${agent.agentId}`

  return (
    <div className="max-w-full rounded-xs border border-rule border-t-2 border-t-custody bg-panel">
      <div className="flex flex-wrap items-start gap-3 border-b border-rule bg-custody/5 px-3 py-3">
        <span
          aria-hidden="true"
          className="grid size-6 shrink-0 place-items-center rounded-pill border border-custody font-mono text-[0.625rem] font-bold text-custody"
        >
          {name.slice(0, 1).toUpperCase()}
        </span>
        <div className="min-w-0">
          <p className="text-[0.8125rem] font-semibold">{name}</p>
          {agent.description === null ? null : (
            <p className="mt-1 max-w-[60ch] text-[0.78rem] text-ink-soft">{agent.description}</p>
          )}
          <p className="mt-2 flex flex-wrap gap-x-3 font-mono text-[0.6875rem] text-faded">
            <span>
              {records.length} branch {records.length === 1 ? "record" : "records"}
            </span>
            {span === null ? null : <span>{formatSpan(span)}</span>}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={branchId}
          onClick={(event) => (open ? onExit() : onOpen(agent.agentId, event.currentTarget))}
          className="inline-flex items-center gap-2 rounded-xs border border-rule bg-panel-2 px-3 py-2 text-[0.75rem] font-semibold text-custody transition-colors hover:border-custody"
        >
          {open ? "Close branch" : "Open branch"} <span aria-hidden="true">{open ? "▾" : "▸"}</span>
        </button>
      </div>

      {open ? (
        <section
          id={branchId}
          aria-label={`${name} conversation`}
          className="border-t border-dashed border-rule px-3 pb-2 pt-3"
        >
          {records.length === 0 ? (
            <p className="text-[0.78rem] italic text-faded">
              This branch returned without filing any records.
            </p>
          ) : (
            <ol className="grid gap-3">
              {records.map((record) => (
                <li key={record.id}>
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
          )}
        </section>
      ) : null}
    </div>
  )
}
