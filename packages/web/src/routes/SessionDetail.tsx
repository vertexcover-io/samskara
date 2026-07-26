import { useEffect, useMemo, useState } from "react"
import { useNavigate, useParams } from "react-router-dom"
import { getJson } from "../api/client.js"
import { parseSessionDetail } from "../api/parse.js"
import type { ApiError, SessionDetailPayload, SessionFacts, TokenTotals } from "../api/types.js"
import { SessionExpired } from "../auth/SessionExpired.js"
import { ArtifactsView } from "../session/ArtifactsView.js"
import { RecordStream } from "../session/RecordStream.js"
import { type Tab, type TabId, Tabs } from "../session/Tabs.js"
import { ToolCallsView } from "../session/ToolCallsView.js"
import { useFocusMode } from "../session/focus.js"
import { type SessionDetail as Detail, artifactsOf, toDetail } from "../session/records.js"
import { LoadingShell } from "../shell/LoadingShell.js"

type State =
  | { readonly phase: "loading" }
  | { readonly phase: "ready"; readonly payload: SessionDetailPayload }
  | { readonly phase: "failed"; readonly error: ApiError }

const Unavailable = () => (
  <span className="text-faded italic underline decoration-dotted">unavailable</span>
)

const formatDuration = (ms: number): string => {
  const totalSeconds = Math.floor(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, "0")}`
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
      className="mt-4 grid w-fit max-w-full grid-cols-2 gap-x-6 gap-y-3 border-t border-rule pt-3 min-[560px]:grid-cols-3 min-[900px]:grid-cols-6"
    >
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

const conversationRecords = (detail: Detail) =>
  detail.records.filter((record) => record.kind !== "tool" && record.kind !== "event")

const tabsFor = (detail: Detail, artifactCount: number): ReadonlyArray<Tab> => [
  { id: "conversation", label: "Conversation", count: conversationRecords(detail).length },
  { id: "timeline", label: "Timeline", count: detail.records.length },
  { id: "tools", label: "Tool Calls", count: detail.toolCalls.length },
  { id: "artifacts", label: "Artifacts", count: artifactCount },
]

const Panel = ({ detail, tab }: { detail: Detail; tab: TabId }) => {
  const focus = useFocusMode()
  const artifacts = useMemo(() => artifactsOf(detail.records), [detail])

  if (tab === "tools") return <ToolCallsView calls={detail.toolCalls} />
  if (tab === "artifacts") return <ArtifactsView artifacts={artifacts} />

  return (
    <RecordStream
      records={tab === "conversation" ? conversationRecords(detail) : detail.records}
      branches={detail.branches}
      showTools={tab === "timeline"}
      spine={tab === "timeline"}
      focusedId={focus.focusedId}
      onOpen={focus.open}
      onExit={focus.exit}
    />
  )
}

const Ready = ({ payload }: { payload: SessionDetailPayload }) => {
  const [tab, setTab] = useState<TabId>("conversation")
  const detail = useMemo(() => toDetail(payload), [payload])
  const artifactCount = useMemo(() => artifactsOf(detail.records).length, [detail])

  return (
    <section>
      <Masthead session={detail.session} tokens={detail.tokenUsage} />

      <div className="mt-4">
        <Tabs tabs={tabsFor(detail, artifactCount)} selected={tab} onSelect={setTab} />
      </div>

      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} className="pt-4">
        <Panel key={tab} detail={detail} tab={tab} />
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
