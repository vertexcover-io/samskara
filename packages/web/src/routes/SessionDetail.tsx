import { type Ref, useCallback, useEffect, useMemo, useRef, useState } from "react"
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
import { CommitsView, PullRequestsView } from "../session/ChangesView.js"
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
import { absoluteTime } from "../time.js"

type State =
  | { readonly phase: "loading" }
  | { readonly phase: "ready"; readonly payload: SessionDetailPayload }
  | { readonly phase: "failed"; readonly error: ApiError }

const Unavailable = () => (
  <span className="text-faded italic underline decoration-dotted">unavailable</span>
)

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

/**
 * Pinned to the top: in a transcript thousands of messages long, which session you are reading
 * and the way back out are the two things you otherwise lose on the first scroll. A single line
 * of title keeps the bar's height fixed, which is what the tab bar below measures itself against.
 */
const SessionHead = ({
  session,
  measure,
}: { session: SessionFacts; measure: Ref<HTMLElement> }) => (
  <header ref={measure} className="sticky top-0 z-30 bg-paper pb-2 pt-2">
    <nav aria-label="Breadcrumb" className="mb-1 font-mono text-[0.72rem] text-ink-soft">
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
    <h1
      title={session.title ?? undefined}
      className="max-w-[62ch] truncate text-[1.375rem] font-semibold leading-tight"
    >
      {session.title ?? <span className="text-faded italic">untitled session</span>}
    </h1>
  </header>
)

const Masthead = ({ session, tokens }: { session: SessionFacts; tokens: TokenTotals }) => (
  <div className="border-b-2 border-ink pb-4">
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
        value={session.createdAt === null ? <Unavailable /> : absoluteTime(session.createdAt)}
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
  </div>
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
  payload: SessionDetailPayload,
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
  { id: "commits", label: "Commits", count: payload.commits.length },
  { id: "pulls", label: "Pull Requests", count: payload.pullRequests.length },
]

const InlineToolsToggle = ({
  checked,
  onChange,
}: { checked: boolean; onChange: (next: boolean) => void }) => (
  <label className="flex w-fit shrink-0 cursor-pointer items-center gap-2 pb-2 text-[0.78rem] text-ink-soft">
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
      spine
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
    <ArtifactsView
      artifacts={artifactsFor(detail, capturedRows(captured))}
      sessionId={detail.session.id}
    />
  </div>
)

const Panel = ({
  detail,
  payload,
  tab,
  inlineTools,
  captured,
  onJump,
}: {
  detail: Detail
  payload: SessionDetailPayload
  tab: TabId
  inlineTools: boolean
  captured: CapturedState
  onJump: (messageId: string) => void
}) => {
  if (tab === "tools")
    return <ToolCallsView calls={detail.toolCalls} agentOf={agentLabelOf(detail)} />
  if (tab === "artifacts") return <ArtifactsPanel detail={detail} captured={captured} />
  if (tab === "commits") return <CommitsView commits={payload.commits} onJump={onJump} />
  if (tab === "pulls")
    return <PullRequestsView pullRequests={payload.pullRequests} onJump={onJump} />

  return <Conversation detail={detail} inlineTools={inlineTools} />
}

const TAB_IDS: ReadonlyArray<TabId> = ["conversation", "tools", "artifacts", "commits", "pulls"]

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

/**
 * Tracks an element's rendered height so a second sticky layer can sit exactly beneath the
 * first. A hardcoded offset would leave a gap -- or clip the title -- at any other font size.
 */
const useMeasuredHeight = <T extends HTMLElement>() => {
  const ref = useRef<T | null>(null)
  const [height, setHeight] = useState(0)

  useEffect(() => {
    const node = ref.current
    if (!node) return
    const measure = () => setHeight(node.getBoundingClientRect().height)
    measure()
    if (typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  return { ref, height }
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
  // A jump belongs on the transcript, so it drops the tab and names the message in one step --
  // two navigations would leave the reader on Commits with the message selected behind it.
  // Inline tools go on unconditionally: capture files a commit against its `git commit` tool
  // call, and landing on a hidden record is the one outcome a jump must never have.
  const jumpToMessage = (messageId: string): void => {
    const merged = new URLSearchParams(params)
    merged.delete("tab")
    merged.set(MESSAGE_PARAM, messageId)
    merged.set("tools", "1")
    setParams(merged)
  }

  const captured = useCapturedArtifacts(payload.session.id)
  const artifactCount = artifactsFor(detail, capturedRows(captured)).length
  const { ref: headRef, height: headHeight } = useMeasuredHeight<HTMLElement>()
  const { ref: tabsRef, height: tabsHeight } = useMeasuredHeight<HTMLDivElement>()

  // The session itself loaded, so a 401 here is a cookie that expired mid-view. Clearing the
  // cached identity is what stops /login bouncing straight back.
  if (captured.phase === "failed" && captured.error.kind === "unauthorized") {
    return <SessionExpired />
  }

  return (
    // Everything the pinned bars cover reads `--sticky-head` to clear them: the agent rail parks
    // below it, and a permalinked message scrolls to just under it rather than behind it.
    <section style={{ "--sticky-head": `${headHeight + tabsHeight}px` } as React.CSSProperties}>
      <SessionHead session={detail.session} measure={headRef} />
      <Masthead session={detail.session} tokens={detail.tokenUsage} />

      {/* Measured rather than a fixed offset: the head's height moves with the reader's font size. */}
      <div ref={tabsRef} className="sticky z-20 mt-4 bg-paper" style={{ top: headHeight }}>
        <div className="flex flex-wrap items-end justify-between gap-x-4 border-b border-rule">
          <Tabs
            tabs={tabsFor(detail, payload, artifactCount, inlineTools)}
            selected={tab}
            onSelect={(next) => update({ tab: next })}
          />
          {tab === "conversation" ? (
            <InlineToolsToggle checked={inlineTools} onChange={(next) => update({ tools: next })} />
          ) : null}
        </div>
      </div>

      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} className="pt-4">
        <Panel
          key={tab}
          detail={detail}
          payload={payload}
          tab={tab}
          inlineTools={inlineTools}
          captured={captured}
          onJump={jumpToMessage}
        />
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
