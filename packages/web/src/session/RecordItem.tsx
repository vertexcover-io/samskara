import { type ReactNode, useEffect, useState } from "react"
import { copyText } from "../account/copyText.js"
import { absoluteTime, clockTime } from "../time.js"
import { Markdown } from "./Markdown.js"
import { ToolCallItem } from "./ToolCallItem.js"
import {
  type Artifact,
  type BlockStats,
  type PromptPart,
  type TimelineRecord,
  anchorOf,
} from "./records.js"

const Unavailable = () => (
  <span className="text-faded italic underline decoration-dotted">unavailable</span>
)

/**
 * Who a record came from, reduced to the three groups a reader actually needs to tell apart while
 * scrolling: what the human sent, what Claude produced, and what neither of them typed.
 */
export type ActorTone = "user" | "assistant" | "aside"

export const toneOf = (record: TimelineRecord): ActorTone => {
  if (record.kind === "prompt" || record.kind === "command") return "user"
  if (record.kind === "assistant" || record.kind === "tool" || record.kind === "artifact") {
    return "assistant"
  }
  return "aside"
}

/** One colour per actor, carried by all three marks so they read as a single signal. */
const GUTTER: Readonly<Record<ActorTone, string>> = {
  user: "border-l-2 border-l-ink",
  assistant: "border-l-2 border-l-custody",
  aside: "border-l-2 border-l-rule",
}

const LABEL: Readonly<Record<ActorTone, string>> = {
  user: "text-ink",
  assistant: "text-custody",
  aside: "text-faded",
}

/** Spine nodes, filled for the human and hollow for everyone else. Read by RecordStream. */
export const SPINE_DOT: Readonly<Record<ActorTone, string>> = {
  user: "before:border-ink before:bg-ink",
  assistant: "before:border-custody before:bg-paper",
  aside: "before:border-rule before:bg-paper",
}

const CopyLink = ({ url }: { url: string }) => {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const settle = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(settle)
  }, [copied])

  return (
    <button
      type="button"
      aria-label="Copy link to this message"
      title="Copy link to this message"
      onClick={() => {
        copyText(url).then(setCopied)
      }}
      className={`inline-flex shrink-0 items-center rounded-xs p-1 opacity-0 transition-opacity hover:bg-panel focus-visible:opacity-100 group-hover:opacity-100 ${
        copied ? "text-ok opacity-100" : "text-ink-soft"
      }`}
    >
      <svg
        viewBox="0 0 16 16"
        aria-hidden="true"
        className="size-3.5 fill-none stroke-current stroke-[1.5]"
      >
        {copied ? (
          <path d="m3.5 8.5 3 3 6-6" strokeLinecap="round" strokeLinejoin="round" />
        ) : (
          <>
            <path d="M6.6 9.4a2.5 2.5 0 0 0 3.54 0l2.12-2.12a2.5 2.5 0 0 0-3.54-3.54l-.7.7" />
            <path d="M9.4 6.6a2.5 2.5 0 0 0-3.54 0L3.74 8.72a2.5 2.5 0 0 0 3.54 3.54l.7-.7" />
          </>
        )}
      </svg>
    </button>
  )
}

const Stamp = ({ timestamp, link }: { timestamp: string | null; link?: string }) => (
  <span className="ml-auto flex items-center gap-1">
    <time
      dateTime={timestamp ?? undefined}
      title={timestamp === null ? undefined : absoluteTime(timestamp)}
      className="font-mono text-[0.72rem] text-ink-soft"
    >
      {clockTime(timestamp)}
    </time>
    {link === undefined ? null : <CopyLink url={link} />}
  </span>
)

const Head = ({
  actor,
  tone,
  kind,
  timestamp,
  model,
  stats,
  link,
}: {
  actor: string
  tone: ActorTone
  kind?: string
  timestamp: string | null
  model?: string | null
  stats?: ReactNode
  link?: string
}) => (
  <div className="flex flex-wrap items-baseline gap-2">
    <span className={`text-[0.75rem] font-semibold ${LABEL[tone]}`}>{actor}</span>
    {model ? <span className="font-mono text-[0.72rem] text-ink-soft">{model}</span> : null}
    {kind ? (
      <span className="text-[0.625rem] font-semibold uppercase tracking-[0.1em] text-faded">
        {kind}
      </span>
    ) : null}
    {stats}
    <Stamp timestamp={timestamp} link={link} />
  </div>
)

const Prose = ({ body }: { body: string }) =>
  body === "" ? (
    <p className="text-[0.78rem] italic text-faded">No text was captured for this record.</p>
  ) : (
    <Markdown source={body} />
  )

const PromptBody = ({ parts }: { parts: ReadonlyArray<PromptPart> }) => {
  if (parts.length === 0) return <Prose body="" />
  return (
    <div className="grid gap-2">
      {parts.map((part) =>
        part.kind === "text" ? (
          <Prose key={part.id} body={part.value} />
        ) : (
          <img
            key={part.id}
            src={part.src}
            alt="Attachment sent with this prompt"
            className="max-h-[28rem] w-fit max-w-full rounded-xs border border-rule"
          />
        ),
      )}
    </div>
  )
}

const Collapsed = ({ label, body }: { label: string; body: string }) => (
  <details className="my-2">
    <summary className="inline-flex cursor-pointer list-none items-center gap-2 rounded-pill border border-dashed border-rule px-3 py-1 text-[0.78rem] italic text-faded">
      <span aria-hidden="true" className="not-italic text-custody">
        ❖
      </span>
      {label}
    </summary>
    <div className="mt-2 max-w-[100ch] border-l-2 border-dashed border-rule px-3 py-2 text-ink-soft">
      <Markdown source={body} />
    </div>
  </details>
)

const Thinking = ({ thinking }: { thinking: string }) => (
  <Collapsed label="Thinking" body={thinking} />
)

/** The opening line, for a summary that says what the block holds without unfolding it. */
const firstLine = (body: string): string => {
  const line =
    body
      .split("\n")
      .find((candidate) => candidate.trim() !== "")
      ?.trim() ?? ""
  return line.length > 72 ? `${line.slice(0, 71)}…` : line
}

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

type ShellProps = {
  readonly anchor: string
  readonly linked: boolean
  readonly tone: ActorTone
}

const Shell = ({ children, anchor, linked, tone }: ShellProps & { children: ReactNode }) => (
  <article
    id={anchor}
    data-actor={tone}
    aria-current={linked ? "location" : undefined}
    // Scroll margin clears the pinned bars, so a permalinked message lands below them, not behind.
    className={`group relative scroll-mt-[calc(var(--sticky-head,0px)_+_1rem)] py-3 ${
      linked ? "-mx-3 rounded-xs bg-stamp/5 px-3 shadow-[inset_3px_0_0_var(--color-stamp)]" : ""
    }`}
  >
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
  readonly link?: string
  readonly linked?: boolean
}

export const RecordItem = ({ record, showTools = true, annex, link, linked = false }: Props) => {
  const tone = toneOf(record)
  const shell: ShellProps = { anchor: anchorOf(record), linked, tone }
  const gutter = GUTTER[tone]

  if (record.kind === "prompt") {
    return (
      <Shell {...shell}>
        <Head actor={record.actor} tone={tone} timestamp={record.timestamp} link={link} />
        <div
          className={`mt-2 w-fit max-w-[104ch] rounded-xs border border-rule ${gutter} bg-panel-2 px-3 py-3`}
        >
          <PromptBody parts={record.parts} />
        </div>
      </Shell>
    )
  }

  // Shown in full, never folded: the arguments are the request the session was opened with, and
  // hiding them is what made a transcript look like it began at the reply.
  if (record.kind === "command") {
    return (
      <Shell {...shell}>
        <Head
          actor={record.actor}
          tone={tone}
          kind="Command"
          timestamp={record.timestamp}
          link={link}
        />
        <div
          className={`mt-2 w-fit max-w-[104ch] rounded-xs border border-rule ${gutter} bg-panel-2 px-3 py-3`}
        >
          <p className="font-mono text-[0.78rem] font-semibold">{record.command}</p>
          {record.args === "" ? null : (
            <div className="mt-2 border-t border-rule pt-2">
              <Markdown source={record.args} />
            </div>
          )}
        </div>
      </Shell>
    )
  }

  // What put it there stands in for who said it: these arrive under the user's role but nobody
  // typed them, and they run to tens of thousands of characters. Folded away by default.
  if (record.kind === "injection") {
    return (
      <Shell {...shell}>
        <Head actor={record.label} tone={tone} timestamp={record.timestamp} link={link} />
        <div className="mt-1 w-fit max-w-[104ch]">
          <Collapsed label={firstLine(record.body) || record.label} body={record.body} />
        </div>
      </Shell>
    )
  }

  if (record.kind === "assistant") {
    return (
      <Shell {...shell}>
        <Head
          actor={record.actor}
          tone={tone}
          timestamp={record.timestamp}
          model={record.model}
          stats={record.block === undefined ? undefined : <BlockSummary block={record.block} />}
          link={link}
        />
        {record.thinking === null && record.body === "" ? null : (
          <div
            className={`mt-2 w-fit max-w-[104ch] rounded-xs border border-rule ${gutter} bg-panel-2 px-3 py-3`}
          >
            {record.thinking === null ? null : <Thinking thinking={record.thinking} />}
            {record.body === "" ? null : <Prose body={record.body} />}
          </div>
        )}
      </Shell>
    )
  }

  if (record.kind === "tool") {
    if (!showTools) return null
    return (
      <Shell {...shell}>
        <Head
          actor="Claude"
          tone={tone}
          kind="Tool call"
          timestamp={record.timestamp}
          link={link}
        />
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
      <Shell {...shell}>
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="rounded-sm bg-custody px-2 py-1 text-[0.5625rem] font-bold uppercase tracking-[0.09em] text-panel-2">
            Subagent spawned
          </span>
          <span className="font-mono text-[0.75rem]">
            {record.agent.agentType ?? record.agent.agentId}
          </span>
          <Stamp timestamp={record.timestamp} link={link} />
        </div>
        {annex ? <div className="mt-2">{annex}</div> : null}
      </Shell>
    )
  }

  if (record.kind === "agentReturn") {
    return (
      <Shell {...shell}>
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="rounded-sm border border-custody px-2 py-1 text-[0.5625rem] font-bold uppercase tracking-[0.09em] text-custody">
            Subagent returned
          </span>
          <span className="font-mono text-[0.75rem]">
            {record.agent.agentType ?? record.agent.agentId} → Claude
          </span>
          <Stamp timestamp={record.timestamp} link={link} />
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
      <Shell {...shell}>
        <Head
          actor="Claude"
          tone={tone}
          kind="Artifact filed"
          timestamp={record.timestamp}
          link={link}
        />
        <div className="mt-2">
          <Exhibit artifact={record.artifact} />
        </div>
      </Shell>
    )
  }

  return (
    <Shell {...shell}>
      <Head
        actor="System"
        tone={tone}
        kind={record.label}
        timestamp={record.timestamp}
        link={link}
      />
      <p className="mt-2 font-mono text-[0.75rem] text-ink-soft">
        <span aria-hidden="true" className="text-custody">
          ◆
        </span>{" "}
        {record.body === "" ? record.label : record.body}
      </p>
    </Shell>
  )
}
