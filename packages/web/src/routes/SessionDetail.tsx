import { useEffect, useMemo, useState } from "react"
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom"
import { getJson } from "../api/client.js"
import { parseSessionDetail } from "../api/parse.js"
import type { ApiError, SessionDetailPayload, SessionFacts, TokenTotals } from "../api/types.js"
import { SessionExpired } from "../auth/SessionExpired.js"
import { AgentRail, agentEntries } from "../session/AgentRail.js"
import { ArtifactsView } from "../session/ArtifactsView.js"
import { RecordStream } from "../session/RecordStream.js"
import { type Tab, type TabId, Tabs } from "../session/Tabs.js"
import { ToolCallsView } from "../session/ToolCallsView.js"
import { DEMO_ARTIFACTS } from "../session/demo-artifacts.js"
import { useFocusMode } from "../session/focus.js"
import {
  type SessionDetail as Detail,
  artifactsOf,
  mergeAssistantRuns,
  toDetail,
} from "../session/records.js"
import { LoadingShell } from "../shell/LoadingShell.js"

type State =
  | { readonly phase: "loading" }
  | { readonly phase: "ready"; readonly payload: SessionDetailPayload }
  | { readonly phase: "failed"; readonly error: ApiError }

const Unavailable = () => (
  <span className="text-faded italic underline decoration-dotted">unavailable</span>
)

const formatMoment = (iso: string): string => {
  const parsed = new Date(iso)
  if (Number.isNaN(parsed.getTime())) return iso
  return parsed.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
}

const formatDuration = (ms: number): string => {
  const totalMinutes = Math.round(ms / 60_000)
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (hours === 0) return `${minutes}m`
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`
}

const Fact = ({ label, value }: { label: string; value: React.ReactNode }) => (
  <div className="flex flex-col gap-1">
    <dt className="text-[0.656rem] font-semibold uppercase tracking-[0.12em] text-faded">
      {label}
    </dt>
    <dd className="font-mono text-[0.875rem] tabular-nums">{value}</dd>
  </div>
)

const Masthead = ({ session, tokens }: { session: SessionFacts; tokens: TokenTotals }) => (
  <header className="border-b-2 border-ink pb-4 pt-2">
    <nav aria-label="Breadcrumb" className="mb-2 font-mono text-[0.72rem] text-ink-soft">
      <Link to="/projects" className="text-custody hover:underline">
        Projects
      </Link>
      <span aria-hidden="true" className="px-2 text-rule">
        /
      </span>
      <Link
        to={`/sessions?project=${encodeURIComponent(session.projectSlug)}`}
        className="text-custody hover:underline"
      >
        {session.projectName}
      </Link>
      <span aria-hidden="true" className="px-2 text-rule">
        /
      </span>
      <Link to="/sessions" className="text-custody hover:underline">
        All sessions
      </Link>
    </nav>
    <h1 className="max-w-[62ch] text-[1.375rem] font-semibold leading-tight">
      {session.title ?? <span className="text-faded italic">untitled session</span>}
    </h1>
    <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[0.78rem] text-ink-soft">
      <span>{session.projectName}</span>
      <span aria-hidden="true" className="text-rule">
        ·
      </span>
      <span>{session.userLogin}</span>
      <span aria-hidden="true" className="text-rule">
        ·
      </span>
      <span>{session.model ?? <Unavailable />}</span>
    </p>

    <dl
      // biome-ignore lint/a11y/useSemanticElements: a dl is the correct element; the role only names it
      role="group"
      aria-label="Session facts"
      className="mt-4 grid w-fit max-w-full grid-cols-2 gap-x-6 gap-y-3 border-t border-rule pt-3 min-[560px]:grid-cols-3 min-[900px]:grid-cols-4 min-[1200px]:grid-cols-7"
    >
      <Fact
        label="Created"
        value={session.createdAt === null ? <Unavailable /> : formatMoment(session.createdAt)}
      />
      <Fact
        label="Duration"
        value={session.durationMs === null ? <Unavailable /> : formatDuration(session.durationMs)}
      />
      <Fact label="Messages" value={session.messageCount.toLocaleString("en-US")} />
      <Fact label="Tool calls" value={session.toolCallCount.toLocaleString("en-US")} />
      <Fact label="Subagents" value={session.subagentCount.toLocaleString("en-US")} />
      <Fact label="Tokens in" value={tokens.inputTokens.toLocaleString("en-US")} />
      <Fact label="Tokens out" value={tokens.outputTokens.toLocaleString("en-US")} />
    </dl>
  </header>
)

const NotFound = ({ onBack }: { onBack: () => void }) => (
  <section className="border border-stamp/40 bg-panel p-8 text-center">
    <p className="text-[0.656rem] font-semibold uppercase tracking-[0.12em] text-stamp">
      Nothing on file
    </p>
    <h2 className="mt-2 text-[0.9375rem] font-semibold">No such session</h2>
    <p className="mx-auto mt-2 max-w-md text-ink-soft">
      It either does not exist or has not been shared with you.
    </p>
    <button
      type="button"
      onClick={onBack}
      className="mt-4 inline-flex items-center justify-center rounded-xs border border-ink bg-ink px-4 py-2 text-panel-2 transition-colors hover:bg-ink-2"
    >
      Back to all sessions
    </button>
  </section>
)

const ErrorState = ({ error }: { error: ApiError }) => (
  <section className="border border-err/40 bg-panel p-6">
    <p className="text-[0.656rem] font-semibold uppercase tracking-[0.12em] text-err">
      Retrieval failed
    </p>
    <p className="mt-2 text-ink-soft">{error.message}</p>
  </section>
)

// Ingest does not yet emit artifact file events, so the explorer falls back to
// representative fixtures until it does.
const artifactsFor = (detail: Detail) => {
  const filed = artifactsOf(detail.records)
  return filed.length === 0 ? DEMO_ARTIFACTS : filed
}

// A branch's tool calls sit in the same list as the main record's, so name the
// agent that made each one.
const agentLabelOf = (detail: Detail) => {
  const byMessage = new Map<string, string>()
  for (const [agentId, records] of detail.branches) {
    const agent = detail.agents.find((candidate) => candidate.agentId === agentId)
    const name = agent?.agentType ?? agentId
    for (const record of records) byMessage.set(record.id, name)
  }
  return (call: { readonly messageId: string }) => byMessage.get(call.messageId) ?? null
}

const conversationRecords = (detail: Detail, withTools: boolean) => {
  const merged = mergeAssistantRuns(
    detail.records.filter((record) => record.kind !== "event"),
    withTools,
  )
  return withTools ? merged : merged.filter((record) => record.kind !== "tool")
}

const tabsFor = (
  detail: Detail,
  artifactCount: number,
  inlineTools: boolean,
): ReadonlyArray<Tab> => [
  {
    id: "conversation",
    label: "Conversation",
    count: conversationRecords(detail, inlineTools).length,
  },
  { id: "tools", label: "Tool Calls", count: detail.toolCalls.length },
  { id: "artifacts", label: "Artifacts", count: artifactCount },
]

const InlineToolsToggle = ({
  checked,
  onChange,
}: { checked: boolean; onChange: (next: boolean) => void }) => (
  <label className="mt-4 flex w-fit cursor-pointer items-center gap-2 text-[0.78rem] text-ink-soft">
    <input
      type="checkbox"
      checked={checked}
      onChange={(event) => onChange(event.target.checked)}
      className="size-3.5 accent-ink"
    />
    Show tool calls inline
  </label>
)

const Conversation = ({ detail, inlineTools }: { detail: Detail; inlineTools: boolean }) => {
  const focus = useFocusMode()
  const [agentId, setAgentId] = useState<string | null>(null)

  const records = useMemo(() => conversationRecords(detail, inlineTools), [detail, inlineTools])
  // Counts come from the full record set: hiding inline tools must not make the
  // rail report zero of them.
  const entries = useMemo(
    () => agentEntries(detail.records, detail.agents, detail.branches),
    [detail],
  )

  // Selecting an agent scrolls its spawn point into view and opens the annex
  // in place, so a branch always stays anchored to where it was called.
  const select = (next: string | null): void => {
    setAgentId(next)
    if (next === null) {
      focus.exit()
      return
    }
    const spawn = document.getElementById(`spawn-${next}`)
    const trigger = spawn?.querySelector("button")
    if (trigger instanceof HTMLElement) {
      focus.open(next, trigger)
      spawn?.scrollIntoView({ behavior: "smooth", block: "center" })
    }
  }

  if (entries.length === 1) {
    return (
      <RecordStream
        records={records}
        branches={detail.branches}
        showTools={inlineTools}
        spine={false}
        focusedId={focus.focusedId}
        onOpen={focus.open}
        onExit={focus.exit}
      />
    )
  }

  return (
    <div className="grid items-start gap-6 min-[900px]:grid-cols-[232px_minmax(0,1fr)]">
      <AgentRail entries={entries} selectedId={agentId} onSelect={select} />
      <div className="min-w-0">
        <RecordStream
          records={records}
          branches={detail.branches}
          showTools={inlineTools}
          spine={false}
          focusedId={focus.focusedId}
          onOpen={(id, trigger) => {
            setAgentId(id)
            focus.open(id, trigger)
          }}
          onExit={() => {
            setAgentId(null)
            focus.exit()
          }}
        />
      </div>
    </div>
  )
}

const Panel = ({
  detail,
  tab,
  inlineTools,
}: { detail: Detail; tab: TabId; inlineTools: boolean }) => {
  const artifacts = useMemo(() => artifactsFor(detail), [detail])

  if (tab === "tools")
    return <ToolCallsView calls={detail.toolCalls} agentOf={agentLabelOf(detail)} />
  if (tab === "artifacts") return <ArtifactsView artifacts={artifacts} />

  return <Conversation detail={detail} inlineTools={inlineTools} />
}

const TAB_IDS: ReadonlyArray<TabId> = ["conversation", "tools", "artifacts"]

const isTabId = (value: string | null): value is TabId =>
  value !== null && TAB_IDS.includes(value as TabId)

const Ready = ({ payload }: { payload: SessionDetailPayload }) => {
  // Tab and tool visibility live in the URL so back/forward restore the view.
  const [params, setParams] = useSearchParams()
  const raw = params.get("tab")
  const tab: TabId = isTabId(raw) ? raw : "conversation"
  const inlineTools = params.get("tools") === "1"

  const update = (next: { tab?: TabId; tools?: boolean }): void => {
    const merged = new URLSearchParams(params)
    if (next.tab !== undefined) {
      if (next.tab === "conversation") merged.delete("tab")
      else merged.set("tab", next.tab)
    }
    if (next.tools !== undefined) {
      if (next.tools) merged.set("tools", "1")
      else merged.delete("tools")
    }
    setParams(merged)
  }

  const detail = useMemo(() => toDetail(payload), [payload])
  const artifactCount = useMemo(() => artifactsFor(detail).length, [detail])

  return (
    <section>
      <Masthead session={detail.session} tokens={detail.tokenUsage} />

      <div className="mt-4">
        <Tabs
          tabs={tabsFor(detail, artifactCount, inlineTools)}
          selected={tab}
          onSelect={(next) => update({ tab: next })}
        />
      </div>

      {tab === "conversation" ? (
        <InlineToolsToggle checked={inlineTools} onChange={(next) => update({ tools: next })} />
      ) : null}

      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} className="pt-4">
        <Panel key={tab} detail={detail} tab={tab} inlineTools={inlineTools} />
      </div>
    </section>
  )
}

export const SessionDetail = () => {
  const { sessionId } = useParams()
  const navigate = useNavigate()
  const [state, setState] = useState<State>({ phase: "loading" })

  useEffect(() => {
    if (sessionId === undefined) return
    let active = true
    setState({ phase: "loading" })

    getJson(`/api/sessions/${encodeURIComponent(sessionId)}`, parseSessionDetail).then((result) => {
      if (!active) return
      setState(
        result.ok
          ? { phase: "ready", payload: result.data }
          : { phase: "failed", error: result.error },
      )
    })

    return () => {
      active = false
    }
  }, [sessionId])

  if (state.phase === "loading") return <LoadingShell label="Retrieving the session record" />

  if (state.phase === "failed") {
    if (state.error.kind === "unauthorized") return <SessionExpired />
    if (state.error.kind === "notFound") return <NotFound onBack={() => navigate("/sessions")} />
    return <ErrorState error={state.error} />
  }

  return <Ready payload={state.payload} />
}
