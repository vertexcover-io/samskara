import { type Ref, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom"
import { useFocusTrap } from "../account/useFocusTrap.js"
import { fetchSessionArtifacts } from "../api/artifacts.js"
import { type ApiError, client, request } from "../api/client.js"
import { repoLabel, repoUrl } from "../api/repo.js"
import {
  fetchAiReview,
  fetchAiReviewJob,
  fetchSessionLearnings,
  fetchSessionReviews,
  type ReviewerChoice,
  startAiReview,
} from "../api/review.js"
import type {
  AiLearning,
  AiReviewCounts,
  AiReviewNumbers,
  AiReviewPartial,
  AiReviewSignals,
  AiTimelineEntry,
  AiTimelineEntryKind,
  CapturedArtifact,
  ReviewerTranscriptEntry,
  SessionDetailPayload,
  SessionFacts,
  SessionLearning,
  SessionRepo,
  SessionReviewSummary,
  TokenTotals,
} from "../api/types.js"
import { SessionExpired } from "../auth/SessionExpired.js"
import { AnalyzeDialog } from "../components/AnalyzeDialog.js"
import { AgentRail, agentEntries } from "../session/AgentRail.js"
import { ArtifactsView } from "../session/ArtifactsView.js"
import { CommitsView, PullRequestsView } from "../session/ChangesView.js"
import { useFocusMode } from "../session/focus.js"
import { AGENT_PARAM, MESSAGE_PARAM, messageLink } from "../session/permalink.js"
import { RecordStream } from "../session/RecordStream.js"
import {
  ancestryOf,
  artifactsOf,
  conversationView,
  type SessionDetail as Detail,
  locate,
  type MessageSite,
  type TimelineRecord,
  toDetail,
} from "../session/records.js"
import { type Tab, type TabId, Tabs } from "../session/Tabs.js"
import { ToolCallsView } from "../session/ToolCallsView.js"
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
}: {
  session: SessionFacts
  measure: Ref<HTMLElement>
}) => (
  <header ref={measure} className="sticky top-0 z-30 bg-paper pb-2 pt-2">
    <nav aria-label="Breadcrumb" className="mb-1 font-mono text-[0.72rem] text-ink-soft">
      <Link to="/projects" className="text-custody hover:underline">
        Projects
      </Link>
      <span aria-hidden="true" className="px-2 text-rule">
        /
      </span>
      <Link
        to={`/sessions?project=${encodeURIComponent(session.projectId)}`}
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

    {/* biome-ignore lint/a11y/noInteractiveElementToNoninteractiveRole: a dl is not interactive; role="group" only labels the grouping semantics */}
    {/* biome-ignore lint/a11y/useSemanticElements: a dl is the correct element; the role only names it */}
    <dl
      role="group"
      aria-label="Session facts"
      className="mt-4 grid w-fit max-w-full grid-cols-2 gap-x-6 gap-y-3 border-t border-rule pt-3 min-[560px]:grid-cols-3 min-[900px]:grid-cols-4 min-[1200px]:grid-cols-7"
    >
      <Fact
        label="Started"
        value={session.startedAt === null ? <Unavailable /> : absoluteTime(session.startedAt)}
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
  reviewCount: number,
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
  { id: "review", label: "Review", count: reviewCount },
]

const InlineToolsToggle = ({
  checked,
  onChange,
}: {
  checked: boolean
  onChange: (next: boolean) => void
}) => (
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

const LESSON_AUDIENCE_LABEL: Readonly<Record<string, string>> = {
  agent: "For agents",
  human: "For humans",
}

// The analyzer id the AI pipeline persists; picked out of the session's review list so the
// block renders from the same fetch the static review already rides on.
const AI_ANALYZER = "ai-v1"

const aiReviewOf = (reviews: ReadonlyArray<SessionReviewSummary>): SessionReviewSummary | null =>
  reviews.find((review) => review.analyzer === AI_ANALYZER) ?? null

const aiSignalsOf = (review: SessionReviewSummary): AiReviewSignals | null =>
  review.signals as AiReviewSignals | null

const timelineEntriesOf = (signals: AiReviewSignals | null): ReadonlyArray<AiTimelineEntry> => {
  if (signals === null) return []
  return signals.lenses.flatMap((lens) => (lens.lens === "timeline" ? lens.entries : []))
}

const learningsOf = (
  signals: AiReviewSignals | null,
  name: "humanLearnings" | "agentLearnings",
): ReadonlyArray<AiLearning> => {
  if (signals === null) return []
  return signals.lenses.flatMap((lens) => (lens.lens === name ? lens.learnings : []))
}

/**
 * The verdict is a sentence, not a stamp: the owner ruled that SHIPPED/MODERATE carry no
 * meaning on their own. The mapping derives from the enum values the analyzers already
 * emit — nothing here invents a new outcome. `clarified` is mapped ahead of the server
 * adopting it; anything unknown still gets a readable sentence.
 */
export const verdictSentence = (outcome: string, friction: string): string => {
  switch (outcome) {
    case "shipped":
      if (friction === "none")
        return "Delivered cleanly — the task's artifact landed with nothing to flag."
      if (friction === "moderate")
        return "Delivered, after real friction — the why lives in the summary below."
      return "Delivered, but most of the session was fighting friction."
    case "productive":
      if (friction === "none") return "Useful work, nothing delivered to show."
      if (friction === "moderate")
        return "Useful work, nothing delivered to show, after some friction."
      return "Useful work, nothing delivered to show, after heavy friction."
    case "struggled":
      return "The agent spent most of the session stuck."
    case "aborted":
      return "The session ended before the work finished."
    case "clarified":
      return "Mostly back-and-forth to shape the task."
    default:
      return `The review reported ${outcome} with ${friction} friction.`
  }
}

// The verdict is the sentence, not a vocabulary word: the dot carries good/bad at a glance
// and the sentence says what happened in plain language. The canonical outcome (shipped,
// productive, struggled, aborted) stays internal — it picks the sentence and the color —
// but never renders, because a bare "aborted" reads as jargon without the definitions.
const OUTCOME_DOT: Readonly<Record<string, string>> = {
  shipped: "bg-ok",
  productive: "bg-ok",
  struggled: "bg-warn",
  aborted: "bg-err",
  clarified: "bg-custody",
}

const Verdict = ({ outcome, friction }: { outcome: string; friction: string }) => (
  <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
    <span
      aria-hidden="true"
      className={`size-2 shrink-0 rounded-full ${OUTCOME_DOT[outcome] ?? "bg-faded"}`}
    />
    <span className="text-[1.0625rem] font-semibold leading-snug">
      {verdictSentence(outcome, friction)}
    </span>
  </p>
)

// Seconds for spans inside a session, clock form for the session itself — the same
// distinction the mock makes: rows read "71s", totals read "4m 38s".
const formatSeconds = (ms: number): string => `${Math.round(ms / 1000)}s`

const formatClock = (ms: number): string => {
  const totalSeconds = Math.round(ms / 1000)
  if (totalSeconds < 60) return `${totalSeconds}s`
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours === 0) return `${minutes}m ${seconds}s`
  return seconds === 0 ? `${hours}h ${minutes}m` : `${hours}h ${minutes}m ${seconds}s`
}

const compactCount = (value: number): string => {
  if (value < 1_000) return `${value}`
  if (value < 1_000_000) return `${(value / 1_000).toFixed(1)}k`
  return `${(value / 1_000_000).toFixed(1)}M`
}

const MetaChip = ({ children }: { children: React.ReactNode }) => (
  <span className="rounded-xs border border-rule bg-panel-2 px-1.5 py-0.5 tabular-nums">
    {children}
  </span>
)

// The numbers the server computed from the export — never the reviewer's own estimates.
// Each chip renders only when its count is present, so a partial numbers block degrades
// to fewer chips rather than zeros.
const NumbersLine = ({ numbers }: { numbers: AiReviewNumbers }) => (
  <p className="mt-3 flex flex-wrap gap-x-2 gap-y-1 font-mono text-[0.72rem] text-ink-soft">
    {numbers.durationMs === undefined ? null : (
      <MetaChip>{formatClock(numbers.durationMs)}</MetaChip>
    )}
    {numbers.recordCount === undefined ? null : (
      <MetaChip>{`${numbers.recordCount} records`}</MetaChip>
    )}
    {numbers.toolCallCount === undefined ? null : (
      <MetaChip>{`${numbers.toolCallCount} tool calls`}</MetaChip>
    )}
    {numbers.inputTokens === undefined && numbers.outputTokens === undefined ? null : (
      <MetaChip>
        {[
          numbers.inputTokens === undefined ? null : `${compactCount(numbers.inputTokens)} in`,
          numbers.outputTokens === undefined ? null : `${compactCount(numbers.outputTokens)} out`,
        ]
          .filter((part): part is string => part !== null)
          .join(" / ")}{" "}
        tokens
      </MetaChip>
    )}
    {numbers.cachedTokens === undefined ? null : (
      <MetaChip>{`${compactCount(numbers.cachedTokens)} cache reads`}</MetaChip>
    )}
  </p>
)

const sumCounts = (counts: AiReviewCounts): number =>
  counts.timeline + counts.human + counts.agent + (counts.breadcrumbs ?? counts.harness ?? 0)

/** Learning titles the healing dropped, with the reason, from the run record's recovery lines. */
const droppedLearnings = (
  recovered: ReadonlyArray<string>,
): ReadonlyArray<{ title: string; reason: string | null }> =>
  recovered.flatMap((line) =>
    [...line.matchAll(/dropped <learning title="([^"]+)">(?: \(([^)]+)\))?/g)].map((m) => ({
      title: m[1] ?? "",
      reason: m[2] ?? null,
    })),
  )

const REASON_LABEL: Readonly<Record<string, string>> = {
  "no evidence ref": "no citation",
  "no next time": "no next-time sentence",
  empty: "empty",
}

// When the reviewer's self-count disagree with what survived parsing, say exactly that —
// which entries were written and which fell out, with why — without the alarm words. With
// the parser defaulting categories and keeping nothing-entries, what remains here is real
// loss.
const PartialBanner = ({
  partial,
  recovered,
}: {
  partial: AiReviewPartial
  recovered: ReadonlyArray<string>
}) => {
  const dropped = droppedLearnings(recovered)
  return (
    <p className="mt-3 border border-dashed border-err/50 bg-panel px-3 py-2 text-[0.82rem] text-ink-soft">
      The reviewer reported writing {sumCounts(partial.claimed)} entries;{" "}
      {sumCounts(partial.parsed)} survived validation
      {dropped.length === 0
        ? "."
        : `; its own notes that fell out: ${dropped
            .map(
              (d) =>
                `“${d.title}”${d.reason === null ? "" : ` (${REASON_LABEL[d.reason] ?? d.reason})`}`,
            )
            .join(", ")}.`}
    </p>
  )
}

// One horizontal bar, proportional to the entries' own durations; a turning point is the
// accent, everything else neutral. The sentence names the largest share of the session.
const STRIP_SEGMENT: Readonly<Record<AiTimelineEntryKind, string>> = {
  phase: "bg-faded",
  event: "bg-faded",
  "turning-point": "bg-stamp",
}

const TimeStrip = ({
  entries,
  totalMs,
}: {
  entries: ReadonlyArray<AiTimelineEntry>
  totalMs: number
}) => {
  const timed = entries.filter((entry) => (entry.durationMs ?? 0) > 0)
  if (timed.length === 0) return null
  const segmentTotal = timed.reduce((sum, entry) => sum + (entry.durationMs ?? 0), 0)
  let largest: AiTimelineEntry | null = null
  for (const entry of timed) {
    if (largest === null || (entry.durationMs ?? 0) > (largest.durationMs ?? 0)) largest = entry
  }
  const share =
    largest !== null && totalMs > 0
      ? `${formatSeconds(largest.durationMs ?? 0)} of ${formatSeconds(totalMs)} — ${Math.round(((largest.durationMs ?? 0) / totalMs) * 100)}% — went to ${largest.title}`
      : null
  return (
    <section className="mt-4">
      <LensHeading>Where the time went</LensHeading>
      <div className="flex h-2.5 w-full overflow-hidden rounded-pill border border-rule bg-panel-2">
        {timed.map((entry) => (
          <div
            key={entry.id}
            className={STRIP_SEGMENT[entry.kind]}
            style={{ width: `${((entry.durationMs ?? 0) / segmentTotal) * 100}%` }}
            title={`${entry.title} · ${formatSeconds(entry.durationMs ?? 0)}`}
          />
        ))}
      </div>
      {share === null ? null : <p className="mt-1.5 text-[0.82rem] text-ink-soft">{share}</p>}
    </section>
  )
}

type GroundingHref = string | null

// A stretch of work is a filled circle, an occurrence a square, the moment things turned
// a diamond — the glyph is the kind, the color marks the turn.
const TIMELINE_KIND_MARKER: Readonly<Record<AiTimelineEntryKind, string>> = {
  phase: "● text-ink-soft",
  event: "■ text-faded",
  "turning-point": "◆ text-stamp",
}

/** How many timeline rows render before the "show all" toggle takes over. */
const visibleTimelineEntries = (
  entries: ReadonlyArray<AiTimelineEntry>,
): ReadonlyArray<AiTimelineEntry> => entries

// The whole row is the link: the owner asked for navigation from the timeline itself, not
// just from the evidence chips, so the row rides the same ?m=+tab machinery they use.
const TimelineEntryRow = ({
  entry,
  href,
  totalMs,
}: {
  entry: AiTimelineEntry
  href: GroundingHref
  totalMs: number
}) => {
  const duration = entry.durationMs
  const share =
    duration !== undefined && totalMs > 0
      ? `${Math.max(1, Math.round((duration / totalMs) * 100))}% of the session`
      : null
  const meta = [
    duration === undefined ? null : formatSeconds(duration),
    share,
    entry.startMs === undefined || entry.startMs === 0
      ? null
      : `starts ${formatSeconds(entry.startMs)} in`,
    `seq ${entry.fromSeq}–${entry.toSeq}`,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ")
  const body = (
    <>
      <span
        aria-hidden="true"
        className={`mt-0.5 shrink-0 font-mono text-[0.9rem] leading-snug ${TIMELINE_KIND_MARKER[entry.kind]}`}
      />
      <span className="min-w-0">
        <span className="block text-[0.9375rem] font-semibold leading-snug">{entry.title}</span>
        <span className="mt-0.5 block font-mono text-[0.72rem] tabular-nums text-ink-soft">
          {meta}
        </span>
        <span className="mt-1 block text-[0.82rem] text-ink-soft">{entry.summary}</span>
      </span>
    </>
  )
  return (
    <li className="border border-rule bg-panel transition-colors hover:border-ink-soft">
      {href === null ? (
        <div className="flex gap-3 p-3">{body}</div>
      ) : (
        <Link to={href} className="flex gap-3 p-3">
          {body}
        </Link>
      )}
    </li>
  )
}

const TimelineSection = ({
  entries,
  linkFor,
  totalMs,
}: {
  entries: ReadonlyArray<AiTimelineEntry>
  linkFor: (messageId: string) => GroundingHref
  totalMs: number
}) => {
  const visible = visibleTimelineEntries(entries)
  return (
    <section className="mt-4">
      <LensHeading>Timeline</LensHeading>
      <ol aria-label="review timeline" className="flex flex-col gap-2">
        {visible.map((entry) => {
          const firstMessageId = entry.messageIds[0]
          return (
            <TimelineEntryRow
              key={entry.id}
              entry={entry}
              href={firstMessageId === undefined ? null : linkFor(firstMessageId)}
              totalMs={totalMs}
            />
          )
        })}
      </ol>
    </section>
  )
}

const Chip = ({ tone, children }: { tone: string; children: React.ReactNode }) => (
  <span
    className={`inline-flex items-center rounded-xs border px-2 py-0.5 font-mono text-[0.72rem] font-semibold uppercase tracking-[0.06em] ${tone}`}
  >
    {children}
  </span>
)

const SEVERITY_TONE: Readonly<Record<string, string>> = {
  low: "border-rule text-ink-soft",
  medium: "border-warn/40 text-warn",
  high: "border-err/40 text-err",
}

// Titles beginning this way are explicit nothing-entries: the audience was considered and
// came up empty (mirrors NOTHING_TO_CHANGE_PREFIX in @samskara/core's lens schema).
const NOTHING_TO_CHANGE_PREFIX = "Nothing to change"

const isNothingEntry = (title: string): boolean => title.startsWith(NOTHING_TO_CHANGE_PREFIX)

// One learning, one accordion: the closed row carries severity + title + cost — the triage
// view — and expanding reveals the situation, the imperative, and the transcript evidence.
const LearningRow = ({
  learning,
  linkFor,
}: {
  learning: AiLearning
  linkFor: (messageId: string) => GroundingHref
}) => {
  const [open, setOpen] = useState(false)

  if (isNothingEntry(learning.title)) {
    return (
      <li className="border border-dashed border-rule bg-panel px-3 py-2">
        <p className="text-[0.875rem] text-ink-soft">{learning.title}</p>
      </li>
    )
  }

  return (
    <li className="border border-rule bg-panel">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex w-full flex-wrap items-baseline gap-x-2 gap-y-1 p-3 text-left transition-colors hover:bg-panel-2"
      >
        {learning.severity === undefined ? null : (
          <Chip tone={SEVERITY_TONE[learning.severity] ?? "border-rule text-ink-soft"}>
            {learning.severity}
          </Chip>
        )}
        <span className="text-[0.9375rem] font-semibold leading-snug">{learning.title}</span>
        {learning.cost === undefined ? null : (
          <span className="font-mono text-[0.72rem] text-ink-soft">{learning.cost}</span>
        )}
      </button>
      {open ? (
        <div className="border-t border-rule px-3 pb-3 pt-2">
          <p className="text-[0.82rem] text-ink-soft">{learning.detail}</p>
          {learning.nextTime === undefined || learning.nextTime.trim() === "" ? null : (
            <p className="mt-1.5 text-[0.82rem] text-ink">
              <span className="font-semibold">Next time:</span> {learning.nextTime}
            </p>
          )}
          <ul className="mt-1.5 flex flex-wrap gap-1.5">
            {learning.evidence.map((item) => {
              const href = linkFor(item.messageId)
              const line = `seq ${item.seq} · ${item.what}`
              return (
                <li key={`${item.seq}·${item.messageId}`}>
                  {href === null ? (
                    <span className="rounded-xs border border-rule px-1.5 py-0.5 font-mono text-[0.72rem] text-ink-soft">
                      {line}
                    </span>
                  ) : (
                    <Link
                      to={href}
                      className="rounded-xs border border-rule px-1.5 py-0.5 font-mono text-[0.72rem] text-custody hover:underline"
                    >
                      {line}
                    </Link>
                  )}
                </li>
              )
            })}
          </ul>
        </div>
      ) : null}
    </li>
  )
}

const LensHeading = ({ children }: { children: React.ReactNode }) => (
  <h3 className="mb-2 text-[0.656rem] font-semibold uppercase tracking-[0.12em] text-faded">
    {children}
  </h3>
)

// The two audiences the owner ruled: what the person could do differently and what the
// agent could do better. Breadcrumbs (reusable discoveries) render as their own section
// below; the legacy harness lens is no longer shown at all.
const LEARNING_GROUPS: ReadonlyArray<{
  readonly heading: string
  readonly name: "humanLearnings" | "agentLearnings"
}> = [
  { heading: "What you could do differently", name: "humanLearnings" },
  { heading: "What the agent could do better", name: "agentLearnings" },
]

/** Reusable discoveries from the breadcrumbs lens: tools, queries, paths worth keeping. */ const breadcrumbsOf =
  (signals: AiReviewSignals | null): ReadonlyArray<AiLearning> => {
    if (signals === null) return []
    return signals.lenses.flatMap((lens) => (lens.lens === "breadcrumbs" ? lens.learnings : []))
  }

// The reviewer's own session in a modal: role-labeled entries and inline tool calls, the
// same actor treatment the conversation tab uses, so reading a review's provenance feels
// like reading any other session.
const ROLE_LABEL: Readonly<Record<"user" | "assistant", string>> = {
  user: "Prompt",
  assistant: "Reviewer",
}

const ReviewerSessionModal = ({
  open,
  onClose,
  transcript,
  tail,
}: {
  open: boolean
  onClose: () => void
  transcript: ReadonlyArray<ReviewerTranscriptEntry>
  tail: string | undefined
}) => {
  const dialogRef = useFocusTrap<HTMLDialogElement>({ active: open, onEscape: onClose })
  if (!open) return null
  return (
    <div className="fixed inset-0 z-30 flex items-start justify-center bg-ink/30 p-4 pt-16">
      <dialog
        ref={dialogRef}
        open
        aria-modal="true"
        aria-labelledby="reviewer-session-title"
        className="relative w-full max-w-2xl border border-rule bg-panel-2 p-6 text-ink shadow-overlay"
      >
        <div className="flex items-baseline justify-between gap-3">
          <h2 id="reviewer-session-title" className="text-[1.375rem] font-semibold leading-tight">
            Reviewer session
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-[0.78rem] font-semibold text-ink-soft underline"
          >
            Close
          </button>
        </div>
        <div className="mt-4 max-h-[60vh] overflow-y-auto">
          {transcript.length === 0 ? (
            <pre className="whitespace-pre-wrap rounded-xs border border-rule bg-paper p-2 font-mono text-[0.72rem] leading-5 text-ink-soft">
              {tail}
            </pre>
          ) : (
            <ol className="flex flex-col divide-y divide-rule">
              {transcript.map((entry, index) => (
                <li
                  key={`${entry.role}:${entry.at ?? index}:${entry.text ?? ""}`}
                  data-actor={entry.role}
                  className="py-2"
                >
                  <p className="font-mono text-[0.656rem] font-semibold uppercase tracking-[0.1em] text-custody">
                    {ROLE_LABEL[entry.role]}
                    {entry.at === undefined ? null : (
                      <span className="ml-2 font-normal text-faded">{absoluteTime(entry.at)}</span>
                    )}
                  </p>
                  {entry.text === undefined ? null : (
                    <p className="mt-1 whitespace-pre-wrap text-[0.82rem] leading-5">
                      {entry.text}
                    </p>
                  )}
                  {entry.tools === undefined
                    ? null
                    : entry.tools.map((tool) => (
                        <p
                          key={`${tool.name}:${tool.input}`}
                          className="mt-1 truncate font-mono text-[0.72rem] text-ink-soft"
                          title={`${tool.name}: ${tool.input}`}
                        >
                          <span className="font-semibold">{tool.name}</span> {tool.input}
                        </p>
                      ))}
                </li>
              ))}
            </ol>
          )}
        </div>
      </dialog>
    </div>
  )
}

const AiReviewCard = ({
  review,
  analysis,
  onRedo,
}: {
  review: SessionReviewSummary
  analysis: AiAnalysis
  onRedo: (choice: ReviewerChoice) => void
}) => {
  const [params] = useSearchParams()
  const { pathname } = useLocation()

  const signals = aiSignalsOf(review)

  // A grounding link names the record in the ?m= permalink the conversation already resolves,
  // and says which tab to land on — from here that is always the conversation. Timeline rows
  // and evidence chips ride the same link, so everything deep-links one way. The review
  // cites export aliases (msg-N); run.recordIds is the seq → real-id bridge, so a link
  // scrolls to the actual record instead of landing nowhere.
  const recordIds = signals?.run?.recordIds
  const linkFor = useCallback(
    (messageId: string): GroundingHref => {
      const alias = /^(?:msg-)?(\d+)$/.exec(messageId)
      const resolved =
        alias !== null && recordIds !== undefined
          ? (recordIds[Number(alias[1])] ?? null)
          : messageId
      if (resolved === null) return null
      const targeted = new URLSearchParams(params)
      targeted.set(MESSAGE_PARAM, resolved)
      targeted.set("tab", "conversation")
      return `${pathname}?${targeted}`
    },
    [recordIds, params, pathname],
  )
  const entries = timelineEntriesOf(signals)
  const groups = LEARNING_GROUPS.map((group) => ({
    ...group,
    learnings: learningsOf(signals, group.name),
  })).filter((group) => group.learnings.length > 0)
  const breadcrumbs = breadcrumbsOf(signals)
  const numbers = signals?.numbers
  const totalMs = numbers?.durationMs ?? signals?.totalDurationMs ?? 0
  const [redoOpen, setRedoOpen] = useState(false)
  const redoRef = useRef<HTMLButtonElement>(null)
  const [logOpen, setLogOpen] = useState(false)

  return (
    <article className="border border-rule bg-panel p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-xs border border-rule px-2 py-0.5 font-mono text-[0.72rem] text-ink-soft">
          AI review
        </span>
        <span className="font-mono text-[0.72rem] text-faded">
          Analyzed {absoluteTime(review.analyzedAt ?? review.createdAt)}
        </span>
        <button
          ref={redoRef}
          type="button"
          onClick={() => setRedoOpen(true)}
          disabled={analysis.phase === "running"}
          className="ml-auto rounded-xs border border-rule px-2 py-0.5 font-mono text-[0.72rem] text-ink-soft transition-colors hover:border-ink-soft hover:bg-panel-2 disabled:opacity-60"
        >
          {analysis.phase === "running" ? "Redo running…" : "Redo review"}
        </button>
      </div>
      <Verdict outcome={review.outcome} friction={review.friction} />
      {signals === null ? null : (
        <p className="mt-1.5 font-mono text-[0.72rem] text-ink-soft">
          {signals.model} · {signals.harness}
        </p>
      )}
      {/* A redo's state would otherwise be invisible: the analyze section only renders when
       * no review exists, so every redo phase has to surface here, on the card itself. */}
      {analysis.phase === "running" ? (
        <p className="mt-1.5 font-mono text-[0.72rem] text-ink-soft">
          Redo running… (started {absoluteTime(analysis.startedAt)})
        </p>
      ) : null}
      {analysis.phase === "failed" ? (
        <p role="alert" className="mt-1.5 text-[0.82rem] text-err">
          Redo failed — {analysis.message} You can try again.
        </p>
      ) : null}
      {analysis.phase === "forbidden" ? (
        <p className="mt-1.5 text-[0.82rem] text-ink-soft">
          You need edit rights on this project to run an AI review.
        </p>
      ) : null}
      {analysis.phase === "congested" ? (
        <p className="mt-1.5 text-[0.82rem] text-ink-soft">
          The server is running 4 analyses already — try again in a minute.
        </p>
      ) : null}
      <p className="mt-2 text-ink">{review.summary}</p>
      {numbers === undefined ? null : <NumbersLine numbers={numbers} />}
      {signals?.partial === undefined ? null : (
        <PartialBanner partial={signals.partial} recovered={signals.run?.recovered ?? []} />
      )}

      {entries.length === 0 ? null : (
        <>
          <TimeStrip entries={entries} totalMs={totalMs} />
          <TimelineSection entries={entries} linkFor={linkFor} totalMs={totalMs} />
        </>
      )}

      {groups.length === 0 ? null : (
        <section className="mt-4">
          <LensHeading>Learnings</LensHeading>
          {groups.map((group) => (
            <div key={group.heading} className="mt-3">
              <h4 className="mb-1.5 text-[0.875rem] font-semibold">{group.heading}</h4>
              <ul className="flex flex-col gap-2">
                {group.learnings.map((learning) => (
                  <LearningRow key={learning.title} learning={learning} linkFor={linkFor} />
                ))}
              </ul>
            </div>
          ))}
        </section>
      )}

      {breadcrumbs.length === 0 ? null : (
        <section className="mt-4">
          <LensHeading>Breadcrumbs and tools worth keeping</LensHeading>
          <ul className="flex flex-col gap-2">
            {breadcrumbs.map((learning) => (
              <LearningRow key={learning.title} learning={learning} linkFor={linkFor} />
            ))}
          </ul>
        </section>
      )}

      {/* The reviewer's own session, rendered like the conversation tab: who said what and
       * which tools ran, captured from its sandbox before the workspace was deleted. Falls
       * back to the raw output tail when no structured transcript was captured. */}
      {signals?.run?.transcript === undefined && signals?.run?.agentLog === undefined ? null : (
        <>
          <button
            type="button"
            onClick={() => setLogOpen(true)}
            className="mt-4 rounded-xs border border-rule px-2 py-0.5 font-mono text-[0.72rem] text-ink-soft transition-colors hover:border-ink-soft hover:bg-panel-2"
          >
            Reviewer session
          </button>
          <ReviewerSessionModal
            open={logOpen}
            onClose={() => setLogOpen(false)}
            transcript={signals?.run?.transcript ?? []}
            tail={signals?.run?.agentLog}
          />
        </>
      )}
      <AnalyzeDialog
        open={redoOpen}
        onClose={() => setRedoOpen(false)}
        restoreFocusTo={() => redoRef.current}
        onRun={(choice) => {
          setRedoOpen(false)
          onRedo({ ...choice, force: true })
        }}
      />
    </article>
  )
}

type AiAnalysis =
  | { readonly phase: "idle" }
  | { readonly phase: "running"; readonly startedAt: number; readonly jobId?: string }
  | { readonly phase: "forbidden" }
  | { readonly phase: "congested" }
  | { readonly phase: "failed"; readonly message: string }

const AnalyzeSection = ({
  analysis,
  onStart,
}: {
  analysis: AiAnalysis
  onStart: (choice: ReviewerChoice) => void
}) => {
  const [dialogOpen, setDialogOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const running = analysis.phase === "running"
  return (
    <section className="border border-dashed border-rule bg-panel p-4">
      <div className="flex flex-wrap items-center gap-3">
        <button
          ref={buttonRef}
          type="button"
          onClick={() => setDialogOpen(true)}
          disabled={running}
          className="rounded-xs border border-rule px-2 py-0.5 text-ink-soft transition-colors hover:border-ink-soft hover:bg-panel disabled:cursor-default disabled:opacity-60 disabled:hover:border-rule disabled:hover:bg-transparent"
        >
          Analyze with AI
        </button>
        {analysis.phase === "running" ? (
          <span className="font-mono text-[0.72rem] text-ink-soft">
            Analyzing… (started {absoluteTime(analysis.startedAt)})
          </span>
        ) : null}
        {analysis.phase === "forbidden" ? (
          <span className="text-[0.82rem] text-ink-soft">
            You need edit rights on this project to run an AI review.
          </span>
        ) : null}
        {analysis.phase === "congested" ? (
          <span className="text-[0.82rem] text-ink-soft">
            The server is running 4 analyses already — try again in a minute.
          </span>
        ) : null}
        {analysis.phase === "failed" ? (
          <span className="text-[0.82rem] text-ink-soft" role="alert">
            Analysis failed — {analysis.message} You can try again.
          </span>
        ) : null}
      </div>
      <AnalyzeDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        restoreFocusTo={() => buttonRef.current}
        onRun={(choice) => {
          setDialogOpen(false)
          onStart(choice)
        }}
      />
    </section>
  )
}

// The same word treatment the Lessons page uses, so a status reads identically in both places.
const statusWord = (status: string): { readonly label: string; readonly className: string } =>
  status === "accepted"
    ? { label: "Accepted", className: "font-semibold text-ok" }
    : status === "superseded"
      ? { label: "Retired", className: "text-faded line-through" }
      : status === "candidate"
        ? { label: "Candidate", className: "font-semibold text-stamp" }
        : { label: status, className: "text-ink-soft" }

const StatusWord = ({ status }: { status: string }) => {
  const { label, className } = statusWord(status)
  return <span className={className}>{label}</span>
}

const LessonRow = ({ row }: { row: SessionLearning }) => (
  <li className="border border-rule bg-panel p-3">
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
      <p className="text-[0.9375rem] font-semibold leading-snug">{row.title}</p>
      <p className="font-mono text-[0.72rem] text-ink-soft">
        <StatusWord status={row.status} />
        {` · seen ${row.occurrenceCount} ${row.occurrenceCount === 1 ? "time" : "times"}`}
      </p>
    </div>
    <p className="mt-1 font-mono text-[0.72rem] text-ink-soft">
      {LESSON_AUDIENCE_LABEL[row.audience] ?? row.audience} · {row.category}
    </p>
  </li>
)

// Reading plus one write: the AI review is the analyzers' only UI trigger, and its run is
// asynchronous — 202 here means a job, not a verdict.
const AI_POLL_INTERVAL_MS = 3000

/** Plain-language reasons for the codes a failed analyze job carries. */
const FAILURE_REASONS: Readonly<Record<string, string>> = {
  harnessFailed: "the reviewer harness exited before finishing",
  deliverableMissing: "the reviewer finished but never wrote review.xml",
  unparseable: "the reviewer's XML could not be parsed",
  invalidSchema: "the review failed schema validation",
  ungrounded: "the review cited records this session does not contain",
}

const failureMessage = (code: string | undefined, detail: unknown): string => {
  const reason = FAILURE_REASONS[code ?? ""] ?? `the run failed (${code ?? "unknown"})`
  if (detail !== null && typeof detail === "object") {
    const record = detail as { message?: unknown; error?: unknown }
    const extra = record.message ?? record.error
    if (typeof extra === "string" && extra !== "") return `${reason}: ${extra}`
  }
  return `${reason}.`
}

const useAiAnalysis = (
  sessionId: string,
  onArrived: () => void,
): { readonly analysis: AiAnalysis; readonly start: (choice: ReviewerChoice) => void } => {
  const [analysis, setAnalysis] = useState<AiAnalysis>({ phase: "idle" })
  const arrived = useRef(onArrived)
  arrived.current = onArrived

  const start = useCallback(
    (choice: ReviewerChoice) => {
      startAiReview(sessionId, choice).then((result) => {
        if (result.ok) {
          setAnalysis({ phase: "running", startedAt: Date.now(), jobId: result.data.jobId })
          return
        }
        if (result.error.code === "notEditable") {
          setAnalysis({ phase: "forbidden" })
          return
        }
        if (result.error.code === "busy") {
          setAnalysis({ phase: "congested" })
          return
        }
        // Someone else's run is already in flight (another tab, another click) — join it
        // through the same poll instead of erroring or duplicating the run.
        if (result.error.code === "analysisAlreadyRunning") {
          setAnalysis({ phase: "running", startedAt: Date.now() })
          return
        }
        // The verdict landed out-of-band — refetch the list so the card replaces the button.
        if (result.error.code === "analysisAlreadyExists") {
          arrived.current()
          return
        }
        setAnalysis({ phase: "failed", message: result.error.message })
      })
    },
    [sessionId],
  )

  // Reload memory: the job registry lives in the server's memory, not the page's, so a
  // reload would otherwise boot in idle and offer an Analyze button that duplicates the
  // running job. One probe on load asks the server instead: a non-null job rejoins the
  // existing poll with the run's own start time — a redo running behind an existing review
  // included, so the reload shows "Redo running…" instead of a stale card with a fresh
  // button.
  useEffect(() => {
    let active = true
    fetchAiReview(sessionId).then((result) => {
      if (!active || !result.ok) return
      if (result.data.job !== null) {
        setAnalysis({
          phase: "running",
          startedAt: Date.parse(result.data.job.startedAt),
          jobId: result.data.job.jobId,
        })
        return
      }
      if (result.data.review !== null) {
        arrived.current()
      }
    })
    return () => {
      active = false
    }
  }, [sessionId])

  // The timer lives in the effect so unmount — or the review arriving — clears it; on arrival
  // the reviews list is re-fetched and the running phase drops.
  // A redo polls too — but its "landed" signal is the JOB status, never the mere existence of
  // a review: a redo runs behind the old verdict, and reading "review exists" as "landed"
  // would clear the running state seconds after it appeared.
  const runningJobId = analysis.phase === "running" ? analysis.jobId : undefined
  useEffect(() => {
    if (analysis.phase !== "running") return
    let active = true
    const landed = (): void => {
      arrived.current()
      setAnalysis({ phase: "idle" })
    }
    const probe = (): void => {
      // Job status is authoritative whenever we know the job.
      if (runningJobId !== undefined) {
        fetchAiReviewJob(sessionId, runningJobId).then((result) => {
          if (!active || !result.ok) return
          // The registry is in-memory: a job the server no longer knows was lost to a
          // restart, and waiting longer cannot produce an outcome.
          if (result.data === null) {
            setAnalysis({
              phase: "failed",
              message: "the server lost track of this run (restart?), so its outcome is unknown.",
            })
            return
          }
          if (result.data.status === "succeeded") {
            landed()
            return
          }
          if (result.data.status === "failed") {
            setAnalysis({
              phase: "failed",
              message: failureMessage(result.data.code, result.data.detail),
            })
          }
        })
        return
      }
      // Joined a run without its job id (another tab started it): the review appearing is
      // the only landed signal, and there is no old verdict to confuse it with.
      fetchAiReview(sessionId).then((result) => {
        if (!active || !result.ok || result.data.review === null) return
        landed()
      })
    }
    const timer = setInterval(probe, AI_POLL_INTERVAL_MS)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [analysis.phase, runningJobId, sessionId])

  return { analysis, start }
}

const ReviewPanel = ({
  review,
  analysis,
  onAnalyze,
}: {
  review: ReviewState
  analysis: AiAnalysis
  onAnalyze: (choice: ReviewerChoice) => void
}) => {
  if (review.phase === "failed")
    return <Notice>The review could not be retrieved. {review.error.message}</Notice>
  if (review.phase === "loading") return null
  // The AI review is the card. The static analyzer still runs server-side, but its counts
  // read as noise next to the AI verdict, so it no longer renders here.
  const ai = aiReviewOf(review.reviews)
  return (
    <div className="flex flex-col gap-4">
      {review.reviews.length === 0 ? (
        <p className="text-ink-soft">This session has not been reviewed yet.</p>
      ) : null}
      {ai === null ? (
        <AnalyzeSection analysis={analysis} onStart={onAnalyze} />
      ) : (
        <AiReviewCard review={ai} analysis={analysis} onRedo={onAnalyze} />
      )}
      {review.reviews.length === 0 ? null : (
        <section>
          <h2 className="mb-2 text-[0.656rem] font-semibold uppercase tracking-[0.12em] text-faded">
            Lessons from this session
          </h2>
          {review.learnings.length === 0 ? (
            <p className="text-ink-soft">No lessons from this session.</p>
          ) : (
            <ul className="flex flex-col gap-3">
              {review.learnings.map((row) => (
                <LessonRow key={row.id} row={row} />
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  )
}

const Panel = ({
  detail,
  payload,
  tab,
  inlineTools,
  captured,
  review,
  analysis,
  onAnalyze,
  onJump,
}: {
  detail: Detail
  payload: SessionDetailPayload
  tab: TabId
  inlineTools: boolean
  captured: CapturedState
  review: ReviewState
  analysis: AiAnalysis
  onAnalyze: (choice: ReviewerChoice) => void
  onJump: (messageId: string) => void
}) => {
  if (tab === "tools")
    return <ToolCallsView calls={detail.toolCalls} agentOf={agentLabelOf(detail)} />
  if (tab === "artifacts") return <ArtifactsPanel detail={detail} captured={captured} />
  if (tab === "commits") return <CommitsView commits={payload.commits} onJump={onJump} />
  if (tab === "pulls")
    return <PullRequestsView pullRequests={payload.pullRequests} onJump={onJump} />
  if (tab === "review")
    return <ReviewPanel review={review} analysis={analysis} onAnalyze={onAnalyze} />

  return <Conversation detail={detail} inlineTools={inlineTools} />
}

const TAB_IDS: ReadonlyArray<TabId> = [
  "conversation",
  "tools",
  "artifacts",
  "commits",
  "pulls",
  "review",
]

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

type ReviewState =
  | { readonly phase: "loading" }
  | {
      readonly phase: "ready"
      readonly reviews: ReadonlyArray<SessionReviewSummary>
      readonly learnings: ReadonlyArray<SessionLearning>
    }
  | { readonly phase: "failed"; readonly error: ApiError }

const useSessionReview = (
  sessionId: string,
): { readonly state: ReviewState; readonly refresh: () => void } => {
  const [state, setState] = useState<ReviewState>({ phase: "loading" })
  const [reloadCount, setReloadCount] = useState(0)
  // A reload is how the AI review's arrival becomes visible: the poller calls refresh and the
  // same two fetches repaint the tab.
  const refresh = useCallback(() => setReloadCount((count) => count + 1), [])

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadCount is never read, only bumped — a change is the refresh.
  useEffect(() => {
    let active = true
    // A refresh keeps the previous content on screen: dropping to "loading" would unmount
    // the whole tab for a frame, and the browser answers a collapsed page by snapping the
    // scroll position back to the top — mid-read.
    setState((prev) => (prev.phase === "ready" ? prev : { phase: "loading" }))

    Promise.all([fetchSessionReviews(sessionId), fetchSessionLearnings(sessionId)]).then(
      ([reviews, learnings]) => {
        if (!active) return
        if (!reviews.ok) {
          setState({ phase: "failed", error: reviews.error })
          return
        }
        if (!learnings.ok) {
          setState({ phase: "failed", error: learnings.error })
          return
        }
        setState({ phase: "ready", reviews: reviews.data, learnings: learnings.data })
      },
    )

    return () => {
      active = false
    }
  }, [sessionId, reloadCount])

  return { state, refresh }
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
  const { state: review, refresh: refreshReview } = useSessionReview(payload.session.id)
  const reviewCount = review.phase === "ready" ? review.reviews.length : 0
  const { analysis, start: startAnalysis } = useAiAnalysis(payload.session.id, refreshReview)
  const { ref: headRef, height: headHeight } = useMeasuredHeight<HTMLElement>()
  const { ref: tabsRef, height: tabsHeight } = useMeasuredHeight<HTMLDivElement>()

  // The session itself loaded, so a 401 here is a cookie that expired mid-view. Clearing the
  // cached identity is what stops /login bouncing straight back.
  if (captured.phase === "failed" && captured.error.kind === "unauthorized") {
    return <SessionExpired />
  }
  if (review.phase === "failed" && review.error.kind === "unauthorized") {
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
            tabs={tabsFor(detail, payload, artifactCount, inlineTools, reviewCount)}
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
          review={review}
          analysis={analysis}
          onAnalyze={startAnalysis}
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

    request(() => client.api.sessions[":id"].$get({ param: { id: sessionId } })).then((result) => {
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
