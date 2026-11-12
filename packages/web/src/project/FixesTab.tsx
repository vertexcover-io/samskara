import { useEffect, useState } from "react"
import { useSearchParams } from "react-router-dom"
import { type ApiError, client, request } from "../api/client.js"
import type { LearningSummary } from "../api/types.js"
import { SessionExpired } from "../auth/SessionExpired.js"
import { LearningCard } from "../learnings/LearningCard.js"
import { LoadingShell } from "../shell/LoadingShell.js"
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
  { value: "skipped", label: "Skipped" },
] as const
const DEFAULT_SHOW = "5"

/** The Show choice: how many to show, and whether it lists the skipped fixes instead. */
const showLimit = (
  value: string | null,
): { readonly value: string; readonly limit: number; readonly skipped: boolean } => {
  const choice = SHOW_CHOICES.find((c) => c.value === value)?.value ?? DEFAULT_SHOW
  const every = choice === "all" || choice === "skipped"
  return {
    value: choice,
    limit: every ? Number.POSITIVE_INFINITY : Number(choice),
    skipped: choice === "skipped",
  }
}

export const FixesTab = ({ projectId }: { readonly projectId: string }) => {
  const [searchParams, setSearchParams] = useSearchParams()
  const [state, setState] = useState<State>({ phase: "loading" })

  const show = showLimit(searchParams.get("show"))
  // A skip or unskip changes one row in place; the filter below moves it between the lists.
  const onSkipChange = (id: string, skippedAt: string | null) =>
    setState((current) =>
      current.phase === "ready"
        ? {
            ...current,
            learnings: current.learnings.map((row) =>
              row.id === id ? { ...row, skippedAt } : row,
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
    request(() => client.api.learnings.$get({ query: { project: projectId } })).then((result) => {
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
  }, [projectId])

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
  // Skipped fixes appear only under Show "Skipped", and only they do.
  const listed =
    state.phase === "ready"
      ? state.learnings.filter((row) => (row.skippedAt !== null) === show.skipped)
      : []
  const empty = show.skipped
    ? {
        title: "No skipped fixes",
        detail: "A fix you skip moves here, and stays here when later runs find it again.",
      }
    : state.phase === "ready" && state.learnings.length > 0
      ? {
          title: "Every fix here is skipped",
          detail: 'Choose Show "Skipped" to see them, or to unskip one.',
        }
      : {
          title: "No learnings here yet",
          detail: "Learnings appear after a learning run reads this project's reviewed sessions.",
        }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-2">
        <div className="flex max-w-full flex-wrap items-end gap-3">
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
              onSkipChange={onSkipChange}
            />
          ))}
        </div>
      )}
    </div>
  )
}
