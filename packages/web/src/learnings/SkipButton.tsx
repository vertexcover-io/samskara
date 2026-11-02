import { useState } from "react"
import { client, request } from "../api/client.js"
import type { LearningDetailPayload } from "../api/types.js"

type Learning = LearningDetailPayload["learning"]

const REFUSED: Readonly<Record<string, string>> = {
  notEditable: "You need edit rights on this project to skip a fix.",
  learningNotFound: "This fix could not be found.",
}

export const SkipButton = ({
  learning,
  onChange,
}: {
  readonly learning: Pick<Learning, "id" | "skippedAt">
  readonly onChange: (updated: Learning) => void
}) => {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const skipped = learning.skippedAt !== null
  const toggle = () => {
    setBusy(true)
    setError(null)
    const param = { param: { id: learning.id } }
    request(() =>
      skipped
        ? client.api.learnings[":id"].skip.$delete(param)
        : client.api.learnings[":id"].skip.$post(param),
    ).then((result) => {
      setBusy(false)
      if (result.ok) onChange(result.data.learning)
      else setError(REFUSED[result.error.code ?? ""] ?? result.error.message)
    })
  }
  return (
    <span className="relative z-10 inline-flex flex-col items-start gap-1">
      <button
        type="button"
        onClick={toggle}
        disabled={busy}
        className="h-8 rounded-xs border border-rule px-3 text-[0.78rem] font-semibold transition-colors hover:border-ink disabled:opacity-60"
      >
        {skipped ? "Unskip" : "Skip"}
      </button>
      {error === null ? null : (
        <span role="alert" className="text-[0.78rem] text-err">
          {error}
        </span>
      )}
    </span>
  )
}
