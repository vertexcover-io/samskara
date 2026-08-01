import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom"
import { fetchSessionArtifacts } from "../api/artifacts.js"
import { getJson } from "../api/client.js"
import { parseSessionDetail } from "../api/parse.js"
import { repoLabel, repoUrl } from "../api/repo.js"
import type {
  ApiError,
  CapturedArtifact,
  SessionDetailPayload,
  SessionFacts,
  SessionRepo,
  TokenTotals,
} from "../api/types.js"
import { SessionExpired } from "../auth/SessionExpired.js"
import { AgentRail, agentEntries } from "../session/AgentRail.js"
import { ArtifactsView } from "../session/ArtifactsView.js"
import { RecordStream } from "../session/RecordStream.js"
import { type Tab, type TabId, Tabs } from "../session/Tabs.js"
import { ToolCallsView } from "../session/ToolCallsView.js"
import { useFocusMode } from "../session/focus.js"
import { AGENT_PARAM, MESSAGE_PARAM, messageLink } from "../session/permalink.js"
import {
  type SessionDetail as Detail,
  type MessageSite,
  type TimelineRecord,
  ancestryOf,
  artifactsOf,
  conversationView,
  locate,
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

/** Opens in a new tab: this is the only link on the page that leaves the app entirely. */
const RepoName = ({ repo }: { repo: SessionRepo }) => {
  const url = repoUrl(repo)
  if (url === null) return <span>{repoLabel(repo)}</span>
  return (
    <a href={url} target="_blank" rel="noreferrer" className="text-custody hover:underline">
      {repoLabel(repo)}
    </a>
  )
}

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
      {session.repo === null ? null : (
        <>
          <span aria-hidden="true" className="text-rule">
            ·
          </span>
          <RepoName repo={session.repo} />
        </>
      )}
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

type CapturedState =
  | { readonly phase: "loading" }
  | { readonly phase: "ready"; readonly rows: ReadonlyArray<CapturedArtifact> }
  | { readonly phase: "failed"; readonly error: ApiError }

const capturedRows = (state: CapturedState): ReadonlyArray<CapturedArtifact> =>
  state.phase === "ready" ? state.rows : []

const Notice = ({ children }: { children: React.ReactNode }) => (
  <p className="mb-4 border border-dashed border-err/50 bg-panel p-4 text-ink-soft">{children}</p>
)

// Captured files and transcript frame-links are two independent signals shown in one browser;
// captured files lead because they are the session's own work product.
const artifactsFor = (detail: Detail, captured: ReadonlyArray<CapturedArtifact>) => [
  ...captured,
  ...artifactsOf(detail.records),
]

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

const tabsFor = (
  detail: Detail,
  artifactCount: number,
  inlineTools: boolean,
): ReadonlyArray<Tab> => [
  {
    id: "conversation",
    label: "Conversation",
    count: conversationView(detail, inlineTools).records.length,
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
  // Which branch is open lives in the URL alongside the tab and the tool toggle, so a reader can
  // share the branch they are in -- and so it has exactly one source of truth.
  const [params, setParams] = useSearchParams()
  const { pathname } = useLocation()
  const agentId = params.get(AGENT_PARAM)

  const setAgent = useCallback(
    (next: string | null, replace = false): void => {
      const merged = new URLSearchParams(params)
      if (next === null) merged.delete(AGENT_PARAM)
      else merged.set(AGENT_PARAM, next)
      setParams(merged, { replace })
    },
    [params, setParams],
  )

  const focus = useFocusMode(agentId, setAgent)

  const view = useMemo(() => conversationView(detail, inlineTools), [detail, inlineTools])
  const sites = useMemo(() => locate(view), [view])

  const target = params.get(MESSAGE_PARAM)
  const site = target === null ? null : (sites.get(target) ?? null)

  const linkFor = useCallback(
    (record: TimelineRecord): string | undefined => {
      const [source] = record.sources
      return source === undefined
        ? undefined
        : messageLink(window.location.origin, pathname, params, source)
    },
    [pathname, params],
  )

  // Restoring a link takes two passes when it points into a branch: the first opens the annex,
  // the second scrolls once the record exists. The ref stops a later pass reopening a branch the
  // reader has since closed.
  const restored = useRef<MessageSite | null>(null)
  useEffect(() => {
    if (site === null || restored.current === site) return
    if (site.agentId !== null && agentId !== site.agentId) {
      // Replaced, not pushed: arriving on a link should not leave a Back step nobody took.
      setAgent(site.agentId, true)
      return
    }
    restored.current = site
    document.getElementById(site.anchor)?.scrollIntoView({ behavior: "smooth", block: "start" })
  }, [site, agentId, setAgent])

  // Opening a branch brings its spawn point into view however the open came from -- the rail, the
  // annex trigger, or a shared link. A ?m= target is more specific, so it does the scrolling.
  // Aligned to the top, never centred: an open annex lives inside its spawn record, so that
  // record runs the height of the whole branch and centring it lands far below the marker.
  const shown = useRef<string | null>(null)
  useEffect(() => {
    if (agentId === null) {
      shown.current = null
      return
    }
    if (shown.current === agentId || site !== null) return
    shown.current = agentId
    document
      .getElementById(`spawn-${agentId}`)
      ?.scrollIntoView({ behavior: "smooth", block: "start" })
  }, [agentId, site])

  // Counts come from the full record set: hiding inline tools must not make the
  // rail report zero of them.
  const entries = useMemo(
    () => agentEntries(detail.records, detail.agents, detail.branches),
    [detail],
  )

  // A branch always stays anchored to where it was called, so selecting an agent opens the annex
  // in place rather than replacing the spine.
  const select = (next: string | null): void => {
    if (next === null) {
      focus.exit()
      return
    }
    const trigger = document.getElementById(`spawn-${next}`)?.querySelector("button")
    focus.open(next, trigger instanceof HTMLElement ? trigger : null)
  }

  const stream = (
    <RecordStream
      records={view.records}
      branches={view.branches}
      showTools={inlineTools}
      spine={false}
      openIds={ancestryOf(agentId, detail.agents)}
      onOpen={focus.open}
      onExit={focus.exit}
      linkFor={linkFor}
      linkedAnchor={site?.anchor ?? null}
    />
  )

  if (entries.length === 1) {
    return stream
  }

  return (
    <div className="grid items-start gap-6 min-[900px]:grid-cols-[232px_minmax(0,1fr)]">
      <AgentRail entries={entries} selectedId={agentId} onSelect={select} />
      <div className="min-w-0">{stream}</div>
    </div>
  )
}

// A failed fetch degrades rather than blanks: the notice names the loss, and whatever the
// transcript itself filed still renders beneath it.
const ArtifactsPanel = ({ detail, captured }: { detail: Detail; captured: CapturedState }) => (
  <div>
    {captured.phase === "failed" ? (
      <Notice>The captured artifacts could not be retrieved. {captured.error.message}</Notice>
    ) : null}
    <ArtifactsView artifacts={artifactsFor(detail, capturedRows(captured))} />
  </div>
)

const Panel = ({
  detail,
  tab,
  inlineTools,
  captured,
}: { detail: Detail; tab: TabId; inlineTools: boolean; captured: CapturedState }) => {
  if (tab === "tools")
    return <ToolCallsView calls={detail.toolCalls} agentOf={agentLabelOf(detail)} />
  if (tab === "artifacts") return <ArtifactsPanel detail={detail} captured={captured} />

  return <Conversation detail={detail} inlineTools={inlineTools} />
}

const TAB_IDS: ReadonlyArray<TabId> = ["conversation", "tools", "artifacts"]

const isTabId = (value: string | null): value is TabId =>
  value !== null && TAB_IDS.includes(value as TabId)

const useCapturedArtifacts = (sessionId: string): CapturedState => {
  const [state, setState] = useState<CapturedState>({ phase: "loading" })

  useEffect(() => {
    let active = true
    setState({ phase: "loading" })

    fetchSessionArtifacts(sessionId).then((result) => {
      if (!active) return
      setState(
        result.ok
          ? { phase: "ready", rows: result.data }
          : { phase: "failed", error: result.error },
      )
    })

    return () => {
      active = false
    }
  }, [sessionId])

  return state
}

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
  const captured = useCapturedArtifacts(payload.session.id)
  const artifactCount = artifactsFor(detail, capturedRows(captured)).length

  // The session itself loaded, so a 401 here is a cookie that expired mid-view. Clearing the
  // cached identity is what stops /login bouncing straight back.
  if (captured.phase === "failed" && captured.error.kind === "unauthorized") {
    return <SessionExpired />
  }

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
        <Panel key={tab} detail={detail} tab={tab} inlineTools={inlineTools} captured={captured} />
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
