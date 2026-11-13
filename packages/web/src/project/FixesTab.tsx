import { useEffect, useState } from "react"
import { useSearchParams } from "react-router-dom"
import { type ApiError, client, request } from "../api/client.js"
import type { LearningDetailPayload, LearningSummary } from "../api/types.js"
import { SessionExpired } from "../auth/SessionExpired.js"
import { LearningCard } from "../learnings/LearningCard.js"
import { FIX_TYPE_LABEL, FIX_TYPE_ORDER } from "../learnings/labels.js"
import { LoadingShell } from "../shell/LoadingShell.js"
import { localDayStart } from "../time.js"
import { controlClass, controlLabelClass } from "./controls.js"

type State =
  | { readonly phase: "loading" }
  | {
      readonly phase: "ready"
      readonly learnings: ReadonlyArray<LearningSummary>
      readonly canEdit: boolean
    }
  | { readonly phase: "failed"; readonly error: ApiError }

/**
 * How many fixes the tab shows: the top few by default, since the server ranks them most
 * important first and the point is what to fix next. `?show=` keeps the choice.
 */
const SHOW_CHOICES = [
  { value: "5", label: "Top 5" },
  { value: "10", label: "Top 10" },
  { value: "20", label: "Top 20" },
  { value: "all", label: "All" },
] as const
const DEFAULT_SHOW = "5"

/** The Show choice: how many to show. */
const showLimit = (value: string | null): { readonly value: string; readonly limit: number } => {
  const choice = SHOW_CHOICES.find((c) => c.value === value)?.value ?? DEFAULT_SHOW
  return { value: choice, limit: choice === "all" ? Number.POSITIVE_INFINITY : Number(choice) }
}

/** Which decisions the tab lists. `?status=` keeps the choice. */
const STATUS_CHOICES = [
  { value: "open", label: "Open" },
  { value: "accepted", label: "Accepted" },
  { value: "skipped", label: "Skipped" },
  { value: "rejected", label: "Rejected" },
  { value: "all", label: "All" },
] as const
type StatusChoice = (typeof STATUS_CHOICES)[number]["value"]

/** Open lists accepted fixes too, marked: accepting a fix keeps it in the list. */
const inStatus = (status: StatusChoice, decision: string): boolean =>
  status === "all" || decision === status || (status === "open" && decision === "accepted")

/** What an empty decided status says. */
const EMPTY_STATUS = {
  accepted: {
    title: "No accepted fixes",
    detail: "A fix you accept stays in the Open list, marked accepted, and is listed here too.",
  },
  skipped: {
    title: "No skipped fixes",
    detail:
      "A fix you skip moves here, and comes back to Open once later runs see it in enough more sessions.",
  },
  rejected: {
    title: "No rejected fixes",
    detail:
      "A fix you reject moves here with its reason. Later runs add problems to it without changing it.",
  },
} as const

export const FixesTab = ({ projectId }: { readonly projectId: string }) => {
  const [searchParams, setSearchParams] = useSearchParams()
  const [state, setState] = useState<State>({ phase: "loading" })

  const show = showLimit(searchParams.get("show"))
  const status: StatusChoice =
    STATUS_CHOICES.find((c) => c.value === searchParams.get("status"))?.value ?? "open"
  // Skipped was a Show choice before the Status filter. A link saved then is rewritten once, in
  // place, so the Status and Show controls own their params afterwards.
  useEffect(() => {
    if (searchParams.get("show") !== "skipped") return
    const next = new URLSearchParams(searchParams)
    next.delete("show")
    if (!next.has("status")) next.set("status", "skipped")
    setSearchParams(next, { replace: true })
  }, [searchParams, setSearchParams])
  // The type and the days as the URL holds them; anything unknown is no filter.
  const type = FIX_TYPE_ORDER.find((t) => t === searchParams.get("type"))
  const from = searchParams.get("from") ?? ""
  const to = searchParams.get("to") ?? ""
  const filtered = type !== undefined || from !== "" || to !== ""
  // The days the reader picked, as the instants the server compares: To counts its whole day.
  const seenFrom = localDayStart(from) ?? undefined
  const seenBefore = localDayStart(to, 1) ?? undefined
  // A decision changes one row in place; the status filter below moves it between the lists.
  const onDecisionChange = (updated: LearningDetailPayload["learning"]) =>
    setState((current) =>
      current.phase === "ready"
        ? {
            ...current,
            learnings: current.learnings.map((row) =>
              row.id === updated.id ? { ...row, ...updated } : row,
            ),
          }
        : current,
    )
  // Changes one search param and keeps the others; an empty value removes it.
  const setParam = (name: string, value: string) => {
    const next = new URLSearchParams(searchParams)
    if (value === "") next.delete(name)
    else next.set(name, value)
    setSearchParams(next)
  }

  useEffect(() => {
    let active = true
    setState({ phase: "loading" })
    request(() =>
      client.api.learnings.$get({
        query: {
          project: projectId,
          ...(type === undefined ? {} : { type }),
          ...(seenFrom === undefined ? {} : { from: seenFrom }),
          ...(seenBefore === undefined ? {} : { to: seenBefore }),
        },
      }),
    ).then((result) => {
      if (!active) return
      setState(
        result.ok
          ? { phase: "ready", learnings: result.data.learnings, canEdit: result.data.canEdit }
          : { phase: "failed", error: result.error },
      )
    })
    return () => {
      active = false
    }
  }, [projectId, type, seenFrom, seenBefore])

  if (state.phase === "failed")
    return state.error.kind === "unauthorized" ? (
      <SessionExpired />
    ) : (
      <section className="border border-err/40 bg-panel p-6" role="alert">
        <p className="text-[0.656rem] font-semibold uppercase tracking-[0.12em] text-err">
          Retrieval failed
        </p>
        <p className="mt-2 text-ink-soft">{state.error.message}</p>
      </section>
    )
  // The status filter is applied here, so a decision moves a card without a reload.
  const listed =
    state.phase === "ready" ? state.learnings.filter((row) => inStatus(status, row.decision)) : []
  const empty =
    filtered && state.phase === "ready" && state.learnings.length === 0
      ? {
          title: "No fixes match these filters",
          detail: "Choose another type or widen the dates to see more.",
        }
      : status !== "open" && status !== "all"
        ? EMPTY_STATUS[status]
        : state.phase === "ready" && state.learnings.length > 0
          ? {
              title: "Every fix here is skipped or rejected",
              detail: 'Choose Status "All" to see them.',
            }
          : {
              title: "No fixes here yet",
              detail: "Fixes appear after a fix run reads this project's reviewed sessions.",
            }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-2">
        <div className="flex max-w-full flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1">
            <span className={controlLabelClass}>Status</span>
            <select
              className={controlClass}
              value={status}
              onChange={(e) => setParam("status", e.target.value === "open" ? "" : e.target.value)}
            >
              {STATUS_CHOICES.map((choice) => (
                <option key={choice.value} value={choice.value}>
                  {choice.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className={controlLabelClass}>Show</span>
            <select
              className={controlClass}
              value={show.value}
              onChange={(e) => setParam("show", e.target.value)}
            >
              {SHOW_CHOICES.map((choice) => (
                <option key={choice.value} value={choice.value}>
                  {choice.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className={controlLabelClass}>Type</span>
            <select
              className={controlClass}
              value={type ?? ""}
              onChange={(e) => setParam("type", e.target.value)}
            >
              <option value="">All types</option>
              {FIX_TYPE_ORDER.map((choice) => (
                <option key={choice} value={choice}>
                  {FIX_TYPE_LABEL[choice]}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className={controlLabelClass}>From</span>
            <input
              type="date"
              className={controlClass}
              value={from}
              max={to === "" ? undefined : to}
              onChange={(e) => setParam("from", e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className={controlLabelClass}>To</span>
            <input
              type="date"
              className={controlClass}
              value={to}
              min={from === "" ? undefined : from}
              onChange={(e) => setParam("to", e.target.value)}
            />
          </label>
        </div>
      </div>

      {state.phase === "loading" ? (
        <LoadingShell label="Retrieving learnings" />
      ) : listed.length === 0 ? (
        <section className="border border-dashed border-rule bg-panel p-8 text-center">
          <p className="text-[0.656rem] font-semibold uppercase tracking-[0.12em] text-stamp">
            {empty.title}
          </p>
          <p className="mx-auto mt-2 max-w-md text-ink-soft">{empty.detail}</p>
        </section>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="font-mono text-[0.72rem] text-ink-soft">
            Showing {Math.min(show.limit, listed.length)} of {listed.length}
          </p>
          {listed.slice(0, show.limit).map((row) => (
            <LearningCard
              key={row.id}
              row={row}
              search={searchParams.size === 0 ? "" : `?${searchParams}`}
              canEdit={state.canEdit}
              onDecisionChange={onDecisionChange}
            />
          ))}
        </div>
      )}
    </div>
  )
}
