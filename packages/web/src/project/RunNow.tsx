import { useState } from "react"
import { Link } from "react-router-dom"
import { useFocusTrap } from "../account/useFocusTrap.js"
import { client, request } from "../api/client.js"
import type { ListedRun } from "../api/types.js"
import { plural } from "../learnings/labels.js"
import { runPath } from "./RunsTab.js"

/** Plain words for why the server would not start a run. */
const RUN_REFUSED: Readonly<Record<string, string>> = {
  notEditable: "You need edit rights on this project to start a run.",
  noHarnessPath:
    "The server has no harness to check learnings against. Set LEARNINGS_HARNESS_REPO (or LEARNINGS_HARNESS_PATH) on the server.",
  projectNotFound: "This project could not be found.",
  // Reached only when the run the server named is no longer open by the time the list is read.
  learningRunAlreadyRunning:
    "Another fix run was already going, and it may have just finished. Reload the page to see it.",
}

type Prompt =
  | { readonly kind: "idle" }
  | { readonly kind: "busy" }
  | { readonly kind: "ask"; readonly reviews: number }
  | { readonly kind: "open"; readonly run: ListedRun }
  | { readonly kind: "failed"; readonly message: string }

const isOpen = (run: ListedRun): boolean => run.status === "waiting" || run.status === "running"

const buttonClass =
  "h-9 rounded-xs border border-rule px-3 text-[0.78rem] font-semibold transition-colors hover:border-ink disabled:cursor-default disabled:opacity-60 disabled:hover:border-rule"

/**
 * Run now: checks the project's runs and reviews first, then starts at once, asks whether to wait
 * for pending reviews, or points at the run already going. `onStarted` reloads the list.
 */
export const RunNow = ({
  projectId,
  onStarted,
}: {
  readonly projectId: string
  readonly onStarted: () => void
}) => {
  const [prompt, setPrompt] = useState<Prompt>({ kind: "idle" })
  const close = () => setPrompt({ kind: "idle" })
  const dialogRef = useFocusTrap<HTMLDialogElement>({
    active: prompt.kind === "ask",
    onEscape: close,
  })

  /** The runs as they are now: the open one, if any, and how many reviews are pending. */
  const check = async () => {
    const result = await request(() =>
      client.api.learnings.runs.$get({ query: { project: projectId } }),
    )
    return result.ok
      ? { open: result.data.runs.find(isOpen) ?? null, reviews: result.data.reviewsWaiting }
      : null
  }

  const start = async (waitForReviews?: boolean) => {
    setPrompt({ kind: "busy" })
    const result = await request(() =>
      client.api.learnings.runs.$post({
        json: {
          project: projectId,
          ...(waitForReviews === undefined ? {} : { waitForReviews }),
        },
      }),
    )
    if (result.ok) {
      close()
      onStarted()
      return
    }
    if (result.error.code === "learningRunAlreadyRunning") {
      const now = await check()
      if (now?.open) return setPrompt({ kind: "open", run: now.open })
    }
    setPrompt({
      kind: "failed",
      message: RUN_REFUSED[result.error.code ?? ""] ?? result.error.message,
    })
  }

  const onClick = async () => {
    setPrompt({ kind: "busy" })
    const now = await check()
    if (now === null) return start()
    if (now.open !== null) return setPrompt({ kind: "open", run: now.open })
    if (now.reviews > 0) return setPrompt({ kind: "ask", reviews: now.reviews })
    return start()
  }

  return (
    <div className="flex flex-col items-end gap-1.5">
      <button
        type="button"
        onClick={onClick}
        disabled={prompt.kind === "busy"}
        className={buttonClass}
      >
        Run now
      </button>
      {prompt.kind === "open" ? (
        <p role="status" className="text-[0.82rem] text-ink-soft">
          {`A fix run is already ${prompt.run.status === "running" ? "running" : "waiting to start"}. `}
          <Link
            to={runPath(projectId, prompt.run.id)}
            className="font-semibold text-custody hover:underline"
          >
            See that run
          </Link>
        </p>
      ) : null}
      {prompt.kind === "failed" ? (
        <p role="alert" className="text-[0.82rem] text-err">
          {prompt.message}
        </p>
      ) : null}
      {prompt.kind === "ask" ? (
        <div className="fixed inset-0 z-30 flex items-start justify-center bg-ink/30 p-4 pt-16">
          <dialog
            ref={dialogRef}
            open
            aria-modal="true"
            aria-labelledby="run-now-dialog-title"
            className="relative w-full max-w-md border border-rule bg-panel-2 p-5 text-ink shadow-overlay"
          >
            <h2 id="run-now-dialog-title" className="text-[0.9375rem] font-semibold">
              {`${plural(prompt.reviews, "review")} ${prompt.reviews === 1 ? "is" : "are"} still waiting or running`}
            </h2>
            <p className="mt-1.5 text-ink-soft">
              Wait for them: the fix run starts when they finish and reads their problems too. Run
              anyway: it starts now with the problems found so far.
            </p>
            <div className="mt-4 flex flex-wrap justify-end gap-2">
              <button type="button" onClick={close} className={buttonClass}>
                Cancel
              </button>
              <button type="button" onClick={() => start(false)} className={buttonClass}>
                Run anyway
              </button>
              <button
                type="button"
                onClick={() => start(true)}
                className="h-9 rounded-xs border border-ink bg-ink px-3 text-[0.78rem] font-semibold text-panel-2"
              >
                Wait for them
              </button>
            </div>
          </dialog>
        </div>
      ) : null}
    </div>
  )
}
