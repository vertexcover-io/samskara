import { type FormEvent, useState } from "react"
import { client, request } from "../api/client.js"
import type { LearningDetailPayload } from "../api/types.js"
import { absoluteTime, relativeTime } from "../time.js"

type Learning = LearningDetailPayload["learning"]
type Decision = Learning["decision"]
/** The body the decision endpoint takes, read from the API client so the two cannot drift. */
type DecisionBody = Parameters<(typeof client.api.learnings)[":id"]["decision"]["$post"]>[0]["json"]

/**
 * The server's `REJECT_REASON_MAX` in `@samskara/core`. The web cannot import core (it pulls in
 * `better-sqlite3`; see `sync/table.ts`), so the number is repeated; the server refuses longer.
 */
const REJECT_REASON_MAX = 200

const REFUSED: Readonly<Record<string, string>> = {
  notEditable: "You need edit rights on this project to decide on a fix.",
  learningNotFound: "This fix could not be found.",
}

/** Every button, in this order; a fix shows each but its own decision, and Reopen once decided. */
const ACTIONS: ReadonlyArray<{ readonly decision: Decision; readonly label: string }> = [
  { decision: "accepted", label: "Accept" },
  { decision: "skipped", label: "Skip" },
  { decision: "rejected", label: "Reject" },
  { decision: "open", label: "Reopen" },
]

const buttonClass =
  "h-8 rounded-xs border border-rule px-3 text-[0.78rem] font-semibold transition-colors hover:border-ink disabled:opacity-60"

/** What was decided and when, with the reason on a rejected fix; nothing on an open one. */
export const DecisionNote = ({
  learning,
}: {
  readonly learning: Pick<Learning, "decision" | "decidedAt" | "rejectReason">
}) => {
  if (learning.decision === "open" || learning.decidedAt === null) return null
  const word = { accepted: "Accepted", skipped: "Skipped", rejected: "Rejected" }[learning.decision]
  return (
    <p className="font-mono text-[0.72rem] text-ink-soft">
      {word}{" "}
      <time dateTime={learning.decidedAt} title={absoluteTime(learning.decidedAt)}>
        {relativeTime(learning.decidedAt)}
      </time>
      {learning.rejectReason === null ? null : `: ${learning.rejectReason}`}
    </p>
  )
}

/** Accept, Skip, Reject and Reopen for one fix. Reject asks for a one-line reason first. */
export const DecisionControls = ({
  learning,
  onChange,
}: {
  readonly learning: Pick<Learning, "id" | "decision">
  readonly onChange: (updated: Learning) => void
}) => {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Null while not asking; the reason typed so far while the Reject field is open.
  const [reason, setReason] = useState<string | null>(null)
  const send = (json: DecisionBody) => {
    setBusy(true)
    setError(null)
    request(() =>
      client.api.learnings[":id"].decision.$post({ param: { id: learning.id }, json }),
    ).then((result) => {
      setBusy(false)
      if (result.ok) {
        setReason(null)
        onChange(result.data.learning)
      } else setError(REFUSED[result.error.code ?? ""] ?? result.error.message)
    })
  }
  const reject = (event: FormEvent) => {
    event.preventDefault()
    if (reason !== null && reason.trim() !== "")
      send({ decision: "rejected", reason: reason.trim() })
  }
  const shown = ACTIONS.filter(
    (action) =>
      action.decision !== learning.decision &&
      (action.decision !== "open" || learning.decision !== "open"),
  )
  return (
    <span className="relative z-10 inline-flex flex-col items-start gap-1">
      {reason === null ? (
        <span className="flex flex-wrap gap-2">
          {shown.map((action) => (
            <button
              key={action.decision}
              type="button"
              disabled={busy}
              className={buttonClass}
              onClick={() =>
                action.decision === "rejected" ? setReason("") : send({ decision: action.decision })
              }
            >
              {action.label}
            </button>
          ))}
        </span>
      ) : (
        <form onSubmit={reject} className="flex flex-wrap items-center gap-2">
          <input
            aria-label="Why reject it?"
            placeholder="Why reject it?"
            value={reason}
            maxLength={REJECT_REASON_MAX}
            onChange={(e) => setReason(e.target.value)}
            className="h-8 min-w-0 flex-1 rounded-xs border border-rule bg-panel px-2 text-[0.82rem]"
          />
          <button type="submit" disabled={busy || reason.trim() === ""} className={buttonClass}>
            Reject
          </button>
          <button
            type="button"
            disabled={busy}
            className={buttonClass}
            onClick={() => setReason(null)}
          >
            Cancel
          </button>
        </form>
      )}
      {error === null ? null : (
        <span role="alert" className="text-[0.78rem] text-err">
          {error}
        </span>
      )}
    </span>
  )
}
