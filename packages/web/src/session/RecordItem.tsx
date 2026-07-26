import type { ReactNode } from "react"
import { Markdown } from "./Markdown.js"
import { ToolCallItem } from "./ToolCallItem.js"
import type { Artifact, BlockStats, TimelineRecord } from "./records.js"

const clockOf = (iso: string | null): string => {
  if (iso === null) return "--:--:--"
  const parsed = new Date(iso)
  return Number.isNaN(parsed.getTime()) ? "--:--:--" : parsed.toISOString().slice(11, 19)
}

const Unavailable = () => (
  <span className="text-faded italic underline decoration-dotted">unavailable</span>
)

const Head = ({
  actor,
  kind,
  timestamp,
  model,
  stats,
}: {
  actor: string
  kind?: string
  timestamp: string | null
  model?: string | null
  stats?: ReactNode
}) => (
  <div className="flex flex-wrap items-baseline gap-2">
    <span className="text-[0.75rem] font-semibold">{actor}</span>
    {model ? <span className="font-mono text-[0.72rem] text-ink-soft">{model}</span> : null}
    {kind ? (
      <span className="text-[0.625rem] font-semibold uppercase tracking-[0.1em] text-faded">
        {kind}
      </span>
    ) : null}
    {stats}
    <time className="ml-auto font-mono text-[0.72rem] text-ink-soft">{clockOf(timestamp)}</time>
  </div>
)

const Prose = ({ body }: { body: string }) =>
  body === "" ? (
    <p className="text-[0.78rem] italic text-faded">No text was captured for this record.</p>
  ) : (
    <Markdown source={body} />
  )

const Thinking = ({ thinking }: { thinking: string }) => (
  <details className="my-2">
    <summary className="inline-flex cursor-pointer list-none items-center gap-2 rounded-pill border border-dashed border-rule px-3 py-1 text-[0.78rem] italic text-faded">
      <span aria-hidden="true" className="not-italic text-custody">
        ❖
      </span>
      Thinking
    </summary>
    <div className="mt-2 max-w-[100ch] border-l-2 border-dashed border-rule px-3 py-2 text-ink-soft">
      <Markdown source={thinking} />
    </div>
  </details>
)

const Exhibit = ({ artifact }: { artifact: Artifact }) => (
  <div className="flex max-w-[104ch] items-start gap-3 rounded-xs border border-rule bg-panel-2 px-3 py-3">
    <span
      aria-hidden="true"
      className="shrink-0 rounded-sm border-[1.5px] border-stamp px-2 py-1 font-mono text-[0.6875rem] font-bold text-stamp"
    >
      EX
    </span>
    <div className="min-w-0">
      <p className="break-all font-mono text-[0.78rem]">
        {artifact.path ?? artifact.url ?? <Unavailable />}
      </p>
      <p className="mt-1 font-mono text-[0.6875rem] text-ink-soft">
        {artifact.title ?? "Filed exhibit"}
      </p>
    </div>
  </div>
)

const Shell = ({ children, id }: { children: ReactNode; id?: string }) => (
  <article id={id} className="relative py-3">
    {children}
  </article>
)

const blockDuration = (ms: number): string => {
  const totalSeconds = Math.round(ms / 1000)
  if (totalSeconds < 60) return `${totalSeconds}s`
  const minutes = Math.floor(totalSeconds / 60)
  return `${minutes}m ${String(totalSeconds % 60).padStart(2, "0")}s`
}

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? "" : "s"}`

const BlockSummary = ({ block }: { block: BlockStats }) => (
  <span className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[0.6875rem] text-faded">
    <span>
      {block.durationMs === null ? "duration unavailable" : blockDuration(block.durationMs)}
    </span>
    <span aria-hidden="true">·</span>
    <span>{plural(block.toolCalls, "tool call")}</span>
    <span aria-hidden="true">·</span>
    <span>{plural(block.messages, "message")}</span>
  </span>
)

type Props = {
  readonly record: TimelineRecord
  readonly showTools?: boolean
  readonly annex?: ReactNode
}

export const RecordItem = ({ record, showTools = true, annex }: Props) => {
  if (record.kind === "prompt") {
    return (
      <Shell>
        <Head actor={record.actor} timestamp={record.timestamp} />
        <div className="mt-2 w-fit max-w-[104ch] rounded-xs border border-rule border-l-2 border-l-ink bg-panel-2 px-3 py-3">
          <Prose body={record.body} />
        </div>
      </Shell>
    )
  }

  if (record.kind === "assistant") {
    return (
      <Shell>
        <Head
          actor={record.actor}
          timestamp={record.timestamp}
          model={record.model}
          stats={record.block === undefined ? undefined : <BlockSummary block={record.block} />}
        />
        <div className="mt-2 w-fit max-w-[104ch] rounded-xs border border-rule bg-panel-2 px-3 py-3">
          {record.thinking === null ? null : <Thinking thinking={record.thinking} />}
          <Prose body={record.body} />
        </div>
      </Shell>
    )
  }

  if (record.kind === "tool") {
    if (!showTools) return null
    return (
      <Shell>
        <Head actor="Claude" kind="Tool call" timestamp={record.timestamp} />
        <div className="mt-2 grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2">
          {record.calls.length === 0 ? (
            <p className="text-[0.78rem] italic text-faded">
              The call record was captured without its payload.
            </p>
          ) : (
            record.calls.map((call) => <ToolCallItem key={call.toolId} call={call} />)
          )}
        </div>
      </Shell>
    )
  }

  if (record.kind === "agentSpawn") {
    return (
      <Shell id={`spawn-${record.agent.agentId}`}>
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="rounded-sm bg-custody px-2 py-1 text-[0.5625rem] font-bold uppercase tracking-[0.09em] text-panel-2">
            Subagent spawned
          </span>
          <span className="font-mono text-[0.75rem]">
            {record.agent.agentType ?? record.agent.agentId}
          </span>
          <time className="ml-auto font-mono text-[0.72rem] text-ink-soft">
            {clockOf(record.timestamp)}
          </time>
        </div>
        {annex ? <div className="mt-2">{annex}</div> : null}
      </Shell>
    )
  }

  if (record.kind === "agentReturn") {
    return (
      <Shell>
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="rounded-sm border border-custody px-2 py-1 text-[0.5625rem] font-bold uppercase tracking-[0.09em] text-custody">
            Subagent returned
          </span>
          <span className="font-mono text-[0.75rem]">
            {record.agent.agentType ?? record.agent.agentId} → Claude
          </span>
          <time className="ml-auto font-mono text-[0.72rem] text-ink-soft">
            {clockOf(record.timestamp)}
          </time>
        </div>
        <p className="mt-2 font-mono text-[0.75rem] text-ink-soft">
          <span aria-hidden="true" className="text-custody">
            ↩
          </span>{" "}
          Branch custody closed.
        </p>
      </Shell>
    )
  }

  if (record.kind === "artifact") {
    return (
      <Shell>
        <Head actor="Claude" kind="Artifact filed" timestamp={record.timestamp} />
        <div className="mt-2">
          <Exhibit artifact={record.artifact} />
        </div>
      </Shell>
    )
  }

  return (
    <Shell>
      <Head actor="System" kind={record.label} timestamp={record.timestamp} />
      <p className="mt-2 font-mono text-[0.75rem] text-ink-soft">
        <span aria-hidden="true" className="text-custody">
          ◆
        </span>{" "}
        {record.body === "" ? record.label : record.body}
      </p>
    </Shell>
  )
}
