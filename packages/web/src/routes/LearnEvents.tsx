import { useEffect, useMemo, useState } from "react"
import { Link, useParams, useSearchParams } from "react-router-dom"
import { type ApiError, client, request } from "../api/client.js"
import { SessionExpired } from "../auth/SessionExpired.js"
import { controlClass, labelClass } from "../components/TextField.js"
import { MESSAGE_PARAM } from "../session/permalink.js"
import { proseOf } from "../session/records.js"
import { LoadingShell } from "../shell/LoadingShell.js"
import { absoluteTime } from "../time.js"

type ListResponse = Awaited<
  ReturnType<Awaited<ReturnType<(typeof client.api)["compound-learnings"]["$get"]>>["json"]>
>
type DetailResponse = Awaited<
  ReturnType<Awaited<ReturnType<(typeof client.api)["compound-learnings"][":id"]["$get"]>>["json"]>
>
type LearnEvent = Extract<ListResponse, { events: unknown }>["events"][number]
type Detail = Extract<DetailResponse, { event: unknown }>
type EvidenceMessage = Detail["evidence"][number]

type Outcome = LearnEvent["outcome"]
type Status = NonNullable<LearnEvent["status"]>

// Typed against the API, so a value removed or renamed in core fails to compile here; a new one
// still needs adding by hand (OUTCOME_LABEL and STATUS_TONE fail to compile until it is).
const FILTERS = {
  outcome: ["new", "occurrence", "lint", "rejected"],
  status: ["accepted", "edited", "rejected", "existing"],
  trigger: ["manual", "auto"],
} as const satisfies {
  outcome: ReadonlyArray<Outcome>
  status: ReadonlyArray<Status>
  trigger: ReadonlyArray<LearnEvent["trigger"]>
}
type FilterKey = keyof typeof FILTERS
type Filters = { readonly [K in FilterKey]?: (typeof FILTERS)[K][number] }

const OUTCOME_LABEL: Record<Outcome, string> = {
  new: "New learning",
  occurrence: "Seen again",
  lint: "Lint rule",
  rejected: "Rejected",
}

const STATUS_TONE: Record<Status, string> = {
  accepted: "text-ok",
  edited: "text-stamp",
  rejected: "text-err",
  existing: "text-ink-soft",
}

/** The learning that was saved: the edited text when the user changed it, else the proposal. */
const savedLearning = (event: LearnEvent): string =>
  event.status === "edited" && event.finalLearning ? event.finalLearning : event.proposedLearning

/** A message's words; one without any (a tool call, an image) shows its kind instead. */
export const messageText = (message: Pick<EvidenceMessage, "content" | "msgType">): string => {
  const content = message.content as { type?: unknown } | null
  const kind = typeof content?.type === "string" ? content.type : message.msgType
  return (kind !== "image" && proseOf(content)) || `[${kind}]`
}

const Failed = ({ error }: { readonly error: ApiError }) =>
  error.kind === "unauthorized" ? (
    <SessionExpired />
  ) : (
    <section className="border border-err/40 bg-panel p-6" role="alert">
      <p className={`${labelClass} text-err`}>Retrieval failed</p>
      <p className="mt-2 text-ink-soft">{error.message}</p>
    </section>
  )

const Meta = ({ event }: { readonly event: LearnEvent }) => (
  <p className="font-mono text-[0.72rem] text-ink-soft">
    {absoluteTime(event.occurredAt)} · {event.userLogin}
    {event.projectName === null ? null : ` · ${event.projectName}`} · {event.trigger}
    {event.skillVersion === null ? null : ` · ${event.skillVersion}`}
  </p>
)

const Verdict = ({ event }: { readonly event: LearnEvent }) => (
  <p className="font-mono text-[0.72rem]">
    <span className="font-semibold">{OUTCOME_LABEL[event.outcome]}</span>
    {event.status ? <span className={STATUS_TONE[event.status]}> · {event.status}</span> : null}
  </p>
)

type ListState =
  | { readonly phase: "loading" }
  | { readonly phase: "ready"; readonly events: ReadonlyArray<LearnEvent> }
  | { readonly phase: "failed"; readonly error: ApiError }

export const LearnEvents = () => {
  const [searchParams, setSearchParams] = useSearchParams()
  const [state, setState] = useState<ListState>({ phase: "loading" })
  const query = searchParams.toString()
  // Only known values for known keys; anything else in the URL is ignored.
  const filters: Filters = useMemo(() => {
    const params = new URLSearchParams(query)
    return Object.fromEntries(
      (Object.keys(FILTERS) as FilterKey[]).flatMap((key) => {
        const value = params.get(key)
        return value !== null && (FILTERS[key] as ReadonlyArray<string>).includes(value)
          ? [[key, value]]
          : []
      }),
    )
  }, [query])

  useEffect(() => {
    let active = true
    setState({ phase: "loading" })
    request(() => client.api["compound-learnings"].$get({ query: filters })).then((result) => {
      if (!active) return
      setState(
        result.ok
          ? { phase: "ready", events: result.data.events }
          : { phase: "failed", error: result.error },
      )
    })
    return () => {
      active = false
    }
  }, [filters])

  const apply = (key: FilterKey, value: string) => {
    const { [key]: _old, ...rest } = filters
    setSearchParams(value === "" ? rest : { ...rest, [key]: value })
  }

  if (state.phase === "loading") return <LoadingShell label="Retrieving learn events" />
  if (state.phase === "failed") return <Failed error={state.error} />

  return (
    <div>
      <h1 className="mb-1 text-[1.375rem] font-semibold leading-tight">Learn events</h1>
      <p className="mb-4 text-ink-soft">
        Every learning the <span className="font-mono">/learn</span> skill proposed, and what the
        user did with it. Open one to read the conversation it came from.
      </p>
      <div className="mb-4 flex flex-wrap items-end gap-2">
        {(Object.keys(FILTERS) as FilterKey[]).map((key) => (
          <label key={key} className="flex flex-col gap-1">
            <span className={labelClass}>{key}</span>
            <select
              className={controlClass}
              value={filters[key] ?? ""}
              onChange={(e) => apply(key, e.target.value)}
            >
              <option value="">Any</option>
              {FILTERS[key].map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
      {state.events.length === 0 ? (
        <p className="border border-rule bg-panel p-6 text-center text-ink-soft">
          No learn events yet.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {state.events.map((event) => (
            <li key={event.id}>
              <Link
                to={`/learn-events/${event.id}`}
                className="block border border-rule bg-panel p-4 transition-colors hover:border-ink"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <Verdict event={event} />
                  <Meta event={event} />
                </div>
                <p className="mt-1.5 font-semibold leading-snug">{savedLearning(event)}</p>
                {event.status === "rejected" && event.rejectionReason ? (
                  <p className="mt-1 text-ink-soft">Rejected: {event.rejectionReason}</p>
                ) : null}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

const Field = ({ label, value }: { readonly label: string; readonly value: string | null }) =>
  value ? (
    <div>
      <dt className={labelClass}>{label}</dt>
      <dd className="mt-0.5 whitespace-pre-wrap">{value}</dd>
    </div>
  ) : null

type DetailState =
  | { readonly phase: "loading" }
  | { readonly phase: "ready"; readonly detail: Detail }
  | { readonly phase: "failed"; readonly error: ApiError }

const noEvidenceReason = (event: LearnEvent): string => {
  if (!event.evidenceFromMessage && !event.evidenceToMessage)
    return "The skill did not record which messages this came from."
  if (event.projectId === null) return "This session's transcript is not available to you yet."
  return "The recorded messages were not found in this session's transcript."
}

export const LearnEventDetail = () => {
  const { id = "" } = useParams()
  const [state, setState] = useState<DetailState>({ phase: "loading" })

  useEffect(() => {
    let active = true
    setState({ phase: "loading" })
    request(() => client.api["compound-learnings"][":id"].$get({ param: { id } })).then(
      (result) => {
        if (!active) return
        setState(
          result.ok
            ? { phase: "ready", detail: result.data }
            : { phase: "failed", error: result.error },
        )
      },
    )
    return () => {
      active = false
    }
  }, [id])

  if (state.phase === "loading") return <LoadingShell label="Retrieving learn event" />
  if (state.phase === "failed") return <Failed error={state.error} />

  const { event, evidence, evidenceRange, truncated } = state.detail
  const isEvidence = (message: EvidenceMessage) =>
    evidenceRange !== null &&
    message.lineNumber >= evidenceRange.first &&
    message.lineNumber <= evidenceRange.last
  const anchor = evidence.find(isEvidence)

  return (
    <div className="flex flex-col gap-4">
      <Link to="/learn-events" className="font-mono text-[0.78rem] text-ink-soft hover:text-ink">
        ← Learn events
      </Link>
      <section className="border border-rule bg-panel p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <Verdict event={event} />
          <Meta event={event} />
        </div>
        <p className="mt-2 text-[1.0625rem] font-semibold leading-snug">{savedLearning(event)}</p>
        <dl className="mt-4 grid gap-3 text-[0.875rem]">
          <Field label="Why it triggered" value={event.whyTriggered} />
          {event.optionsShown.length > 0 ? (
            <div>
              <dt className={labelClass}>Options shown</dt>
              <dd>
                <ol className="mt-0.5 list-decimal pl-5">
                  {event.optionsShown.map((option, index) => (
                    <li
                      key={option}
                      className={
                        String(index + 1) === event.optionUserPicked ? "font-semibold" : undefined
                      }
                    >
                      {option}
                      {String(index + 1) === event.optionUserPicked ? " ← picked" : null}
                    </li>
                  ))}
                </ol>
                {event.optionUserPicked === "other" ? (
                  <p className="mt-1 text-ink-soft">The user wrote their own.</p>
                ) : null}
              </dd>
            </div>
          ) : null}
          <Field label="Proposed" value={event.proposedLearning} />
          <Field label="Saved as (edited)" value={event.finalLearning} />
          <Field label="Rejection reason" value={event.rejectionReason} />
          <Field label="Learning file" value={event.learningFile} />
          <Field label="Replaces" value={event.replaces} />
          <Field label="Folder" value={event.cwd} />
        </dl>
      </section>
      <section className="border border-rule bg-panel p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-semibold">The conversation it came from</h2>
          {event.projectId === null ? null : (
            <Link
              to={`/sessions/${event.sessionId}${anchor === undefined ? "" : `?${MESSAGE_PARAM}=${anchor.id}`}`}
              className="font-mono text-[0.78rem] text-ink-soft hover:text-ink"
            >
              Open the full session →
            </Link>
          )}
        </div>
        {evidence.length === 0 ? (
          <p className="mt-2 text-ink-soft">{noEvidenceReason(event)}</p>
        ) : (
          <ol className="mt-3 flex flex-col gap-2">
            {evidence.map((message) => (
              <li
                key={message.id}
                className={`border-l-2 py-1 pl-3 ${isEvidence(message) ? "border-stamp" : "border-rule opacity-60"}`}
              >
                <p className={labelClass}>{message.role ?? message.msgType}</p>
                <p className="mt-0.5 whitespace-pre-wrap text-[0.875rem]">{messageText(message)}</p>
              </li>
            ))}
          </ol>
        )}
        {truncated ? (
          <p className="mt-3 text-ink-soft">
            Showing the first {evidence.length} messages; the rest are in the full session.
          </p>
        ) : null}
      </section>
    </div>
  )
}
