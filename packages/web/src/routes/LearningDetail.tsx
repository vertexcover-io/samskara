import { useEffect, useState } from "react"
import { Link, useParams, useSearchParams } from "react-router-dom"
import { type ApiError, client, request } from "../api/client.js"
import type { LearningDetailPayload, LearningProblem } from "../api/types.js"
import { SessionExpired } from "../auth/SessionExpired.js"
import { FIX_TYPE_LABEL, IMPACT_LABEL, PRIORITY_TONE, plural } from "../learnings/labels.js"
import { SkipButton } from "../learnings/SkipButton.js"
import { LoadingShell } from "../shell/LoadingShell.js"
import { absoluteTime, relativeTime } from "../time.js"

type State =
  | { readonly phase: "loading" }
  | { readonly phase: "ready"; readonly payload: LearningDetailPayload }
  | { readonly phase: "failed"; readonly error: ApiError }

type SessionProof = {
  readonly sessionId: string
  readonly title: string | null
  readonly problems: ReadonlyArray<LearningProblem>
}

/** The problems grouped by session, each session where its first problem came. */
export const bySession = (problems: ReadonlyArray<LearningProblem>): SessionProof[] => {
  const groups = new Map<string, SessionProof>()
  for (const problem of problems) {
    const found = groups.get(problem.sessionId)
    groups.set(problem.sessionId, {
      sessionId: problem.sessionId,
      title: found?.title ?? problem.sessionTitle,
      problems: [...(found?.problems ?? []), problem],
    })
  }
  return [...groups.values()]
}

/** The list's own filters, so Back lands where the reader left. */
const listSearch = (params: URLSearchParams): string => {
  const kept = new URLSearchParams()
  for (const name of ["project", "show"]) {
    const value = params.get(name)
    if (value !== null) kept.set(name, value)
  }
  const text = kept.toString()
  return text === "" ? "" : `?${text}`
}

const label = "font-mono text-[0.656rem] font-semibold uppercase tracking-[0.12em] text-stamp"

type Learning = LearningDetailPayload["learning"]

const Fix = ({
  payload,
  onChange,
}: {
  readonly payload: LearningDetailPayload
  readonly onChange: (updated: Learning) => void
}) => {
  const { learning, problems } = payload
  const sessions = new Set(problems.map((p) => p.sessionId)).size
  return (
    <section
      aria-label="The fix"
      className="flex min-w-0 flex-col gap-3 border border-rule bg-panel p-4 break-words"
    >
      <h1 className="text-[1.125rem] font-semibold leading-snug">{learning.title}</h1>
      <p className="font-mono text-[0.72rem] text-ink-soft">
        <span
          className={`mr-2 rounded-xs border px-1.5 py-0.5 font-semibold ${PRIORITY_TONE[learning.priority] ?? PRIORITY_TONE.low}`}
        >
          {learning.priority}
        </span>
        {`${plural(problems.length, "problem")} in ${plural(sessions, "session")}`}
      </p>
      <div>
        <p className={label}>What goes wrong</p>
        <p className="mt-1">{learning.problem}</p>
      </div>
      {learning.impact === null ? null : (
        <div>
          <p className={label}>Impact</p>
          <p className="mt-1">
            <span className="font-semibold">
              {IMPACT_LABEL[learning.impact] ?? learning.impact}.
            </span>{" "}
            {learning.impactReason}
          </p>
        </div>
      )}
      {learning.howItHelps === null ? null : (
        <div>
          <p className={label}>How it helps</p>
          <p className="mt-1">{learning.howItHelps}</p>
        </div>
      )}
      <div>
        <p className={label}>The fix ({FIX_TYPE_LABEL[learning.fixType] ?? learning.fixType})</p>
        <p className="mt-1">{learning.fix}</p>
      </div>
      <div>
        <p className={label}>Why {learning.priority}</p>
        <p className="mt-1 text-ink-soft">{learning.priorityReason}</p>
      </div>
      {learning.skippedAt === null ? null : (
        <p className="font-mono text-[0.72rem] text-ink-soft">
          Skipped{" "}
          <time dateTime={learning.skippedAt} title={absoluteTime(learning.skippedAt)}>
            {relativeTime(learning.skippedAt)}
          </time>
        </p>
      )}
      {payload.canEdit ? <SkipButton learning={learning} onChange={onChange} /> : null}
    </section>
  )
}

const Proof = ({ problems }: { readonly problems: ReadonlyArray<LearningProblem> }) => (
  <section aria-label="The proof" className="flex min-w-0 flex-col gap-4 break-words">
    {bySession(problems).map((session) => (
      <article key={session.sessionId} className="border border-rule bg-panel p-4">
        <h2 className="font-semibold leading-snug">
          {session.title ?? "Untitled session"}{" "}
          <span className="font-mono text-[0.72rem] font-normal text-ink-soft">
            {plural(session.problems.length, "problem")}
          </span>
        </h2>
        <ul className="mt-3 flex flex-col gap-3">
          {session.problems.map((problem) => (
            <li key={problem.id}>
              <p className="font-semibold leading-snug">{problem.title}</p>
              <ul className="mt-1.5 flex flex-col gap-2">
                {problem.evidence.map((item) => (
                  <li
                    key={`${item.from}-${item.to}-${item.quote}`}
                    className="border-l border-rule pl-3 text-[0.82rem]"
                  >
                    <blockquote className="font-mono text-[0.78rem]">“{item.quote}”</blockquote>
                    <p className="mt-1 text-ink-soft">{item.why}</p>
                    {item.messageId === null ? (
                      <p className="mt-1 text-[0.72rem] text-ink-soft opacity-70">
                        The message this quote came from could not be found.
                      </p>
                    ) : (
                      <Link
                        to={`/sessions/${session.sessionId}?tab=conversation&m=${encodeURIComponent(item.messageId)}`}
                        className="mt-1 inline-block text-[0.78rem] text-custody underline"
                      >
                        Open message
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      </article>
    ))}
  </section>
)

export const LearningDetail = () => {
  const { learningId = "" } = useParams()
  const [searchParams] = useSearchParams()
  const [state, setState] = useState<State>({ phase: "loading" })

  useEffect(() => {
    let active = true
    setState({ phase: "loading" })
    request(() => client.api.learnings[":id"].$get({ param: { id: learningId } })).then(
      (result) => {
        if (!active) return
        setState(
          result.ok
            ? { phase: "ready", payload: result.data }
            : { phase: "failed", error: result.error },
        )
      },
    )
    return () => {
      active = false
    }
  }, [learningId])

  const onSkipChange = (learning: Learning) =>
    setState((current) =>
      current.phase === "ready"
        ? { phase: "ready", payload: { ...current.payload, learning } }
        : current,
    )

  const back = (
    <Link to={`/learnings${listSearch(searchParams)}`} className="text-[0.82rem] underline">
      ← Back to Fixes
    </Link>
  )
  if (state.phase === "loading") return <LoadingShell label="Retrieving the fix" />
  if (state.phase === "failed")
    return state.error.kind === "unauthorized" ? (
      <SessionExpired />
    ) : (
      <div className="flex flex-col gap-3">
        {back}
        <section className="border border-err/40 bg-panel p-6" role="alert">
          <p className="text-[0.656rem] font-semibold uppercase tracking-[0.12em] text-err">
            Retrieval failed
          </p>
          <p className="mt-2 text-ink-soft">{state.error.message}</p>
        </section>
      </div>
    )
  return (
    <div className="flex flex-col gap-3">
      {back}
      <div className="grid items-start gap-6 min-[900px]:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <Fix payload={state.payload} onChange={onSkipChange} />
        <Proof problems={state.payload.problems} />
      </div>
    </div>
  )
}
