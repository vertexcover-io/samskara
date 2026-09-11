import { useEffect, useId, useRef, useState } from "react"
import { useFocusTrap } from "../account/useFocusTrap.js"
import type { ApiError } from "../api/client.js"
import { fetchReviewerOptions, type ReviewerChoice } from "../api/review.js"
import type { ReviewerOptions } from "../api/types.js"
import { controlClass, labelClass } from "./TextField.js"

const CUSTOM = "__custom__"

type State =
  | { readonly phase: "loading" }
  | { readonly phase: "ready"; readonly options: ReviewerOptions }
  | { readonly phase: "failed"; readonly error: ApiError }

type Props = {
  readonly open: boolean
  readonly onClose: () => void
  readonly onRun: (choice: ReviewerChoice) => void
  readonly restoreFocusTo?: () => HTMLElement | null
}

/**
 * The choices behind "Analyze with AI": which harness CLI runs the reviewer and with which
 * model, fetched live from the server (which knows what is installed). Defaults come from
 * the server's env configuration; "Custom…" escapes the curated model list for anything
 * else a harness accepts.
 */
export const AnalyzeDialog = ({ open, onClose, onRun, restoreFocusTo }: Props) => {
  const [state, setState] = useState<State>({ phase: "loading" })
  const [harness, setHarness] = useState("")
  const [model, setModel] = useState("")
  const [customModel, setCustomModel] = useState("")
  const dialogRef = useFocusTrap<HTMLDialogElement>({
    active: open,
    onEscape: onClose,
    fallbackFocus: restoreFocusTo,
  })
  const harnessId = useId()
  const modelId = useId()
  const customId = useId()
  const ran = useRef(false)

  useEffect(() => {
    if (!open) return
    ran.current = false
    setState({ phase: "loading" })
    setCustomModel("")
    fetchReviewerOptions().then((result) => {
      if (ran.current) return
      setState(
        result.ok
          ? { phase: "ready", options: result.data }
          : { phase: "failed", error: result.error },
      )
      if (!result.ok) return
      const options = result.data
      const wanted =
        options.harnesses.find((entry) => entry.harness === options.defaultHarness) ??
        options.harnesses.find((entry) => entry.available)
      if (wanted === undefined) return
      setHarness(wanted.harness)
      setModel(
        options.defaultHarness === wanted.harness ? options.defaultModel : wanted.defaultModel,
      )
    })
  }, [open])

  if (!open) return null

  const ready = state.phase === "ready" ? state.options : null
  const harnessOptions = ready?.harnesses ?? []
  const current = harnessOptions.find((entry) => entry.harness === harness)
  const models = current?.models ?? []
  const usableHarnesses = harnessOptions.filter((entry) => entry.available)
  const modelIsKnown = model === CUSTOM || models.includes(model)
  const run = (): void => {
    if (ready === null) return
    ran.current = true
    const chosenModel = model === CUSTOM ? customModel.trim() : model === "" ? undefined : model
    onRun({
      harness: harness === "" ? undefined : (harness as "opencode" | "claude"),
      ...(chosenModel === undefined || chosenModel === "" ? {} : { model: chosenModel }),
    })
  }

  return (
    <div className="fixed inset-0 z-30 flex items-start justify-center bg-ink/30 p-4 pt-16">
      <dialog
        ref={dialogRef}
        open
        aria-modal="true"
        aria-labelledby="analyze-dialog-title"
        className="relative w-full max-w-md border border-rule bg-panel-2 p-6 text-ink shadow-overlay"
      >
        <h2 id="analyze-dialog-title" className="text-[1.375rem] font-semibold leading-tight">
          Analyze with AI
        </h2>
        <p className="mt-2 text-ink-soft">
          Choose which reviewer runs the analysis. The server's defaults are preselected.
        </p>

        {state.phase === "loading" ? (
          <p className="mt-4 font-mono text-[0.72rem] text-ink-soft">Loading reviewer options…</p>
        ) : null}

        {state.phase === "failed" ? (
          <p role="alert" className="mt-4 border border-err/40 bg-panel p-3 text-err">
            {state.error.message}
          </p>
        ) : null}

        {ready !== null ? (
          usableHarnesses.length === 0 ? (
            <p role="alert" className="mt-4 border border-err/40 bg-panel p-3 text-err">
              No reviewer CLI is installed on the server (opencode or claude).
            </p>
          ) : (
            <div className="mt-4 flex flex-col gap-3">
              <div>
                <label className={labelClass} htmlFor={harnessId}>
                  Reviewer harness
                </label>
                <select
                  id={harnessId}
                  className={`${controlClass} mt-1 cursor-pointer`}
                  value={harness}
                  onChange={(event) => {
                    setHarness(event.target.value)
                    const next = harnessOptions.find(
                      (entry) => entry.harness === event.target.value,
                    )
                    setModel(next === undefined ? "" : next.defaultModel)
                  }}
                >
                  {harnessOptions.map((entry) => (
                    <option key={entry.harness} value={entry.harness} disabled={!entry.available}>
                      {entry.harness}
                      {entry.available ? "" : " (not installed)"}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className={labelClass} htmlFor={modelId}>
                  Model
                </label>
                <select
                  id={modelId}
                  className={`${controlClass} mt-1 cursor-pointer`}
                  value={modelIsKnown ? model : CUSTOM}
                  onChange={(event) => setModel(event.target.value)}
                >
                  {models.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                  <option value={CUSTOM}>Custom…</option>
                </select>
              </div>
              {model === CUSTOM ? (
                <div>
                  <label className={labelClass} htmlFor={customId}>
                    Custom model id
                  </label>
                  <input
                    id={customId}
                    type="text"
                    className={`${controlClass} mt-1 font-mono`}
                    value={customModel}
                    onChange={(event) => setCustomModel(event.target.value)}
                    placeholder="e.g. minimax-coding-plan/MiniMax-M3"
                  />
                </div>
              ) : null}
            </div>
          )
        ) : null}

        <div className="mt-6 flex items-center gap-3">
          <button
            type="button"
            onClick={run}
            disabled={ready === null || usableHarnesses.length === 0}
            className="border border-ink bg-ink px-3 py-2 text-[0.78rem] font-semibold text-panel-2 transition-colors hover:bg-ink-2 disabled:opacity-60"
          >
            Run analysis
          </button>
          <button
            type="button"
            onClick={onClose}
            className="text-[0.78rem] font-semibold text-ink-soft underline"
          >
            Cancel
          </button>
        </div>
      </dialog>
    </div>
  )
}
