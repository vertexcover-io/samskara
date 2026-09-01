import { useCallback, useEffect, useState } from "react"
import { useNavigate } from "react-router-dom"
import { useFocusTrap } from "../account/useFocusTrap.js"
import { type ApiError, client, request } from "../api/client.js"

type Project = {
  readonly id: string
  readonly slug: string
  readonly sessionCount: number
}

type State =
  | { readonly phase: "idle" }
  | { readonly phase: "deleting" }
  | { readonly phase: "failed"; readonly error: ApiError }

const IDLE: State = { phase: "idle" }

const failureMessage = (error: ApiError): string =>
  error.code === "forbidden"
    ? "This project can no longer be deleted by this account."
    : error.message

type Props = {
  readonly open: boolean
  readonly project: Project
  readonly onClose: () => void
  readonly restoreFocusTo?: () => HTMLElement | null
}

export const DeleteProjectDialog = ({ open, project, onClose, restoreFocusTo }: Props) => {
  const [typed, setTyped] = useState("")
  const [state, setState] = useState<State>(IDLE)
  const navigate = useNavigate()
  const dialogRef = useFocusTrap<HTMLDialogElement>({
    active: open,
    onEscape: onClose,
    fallbackFocus: restoreFocusTo,
  })

  useEffect(() => {
    if (!open) {
      setTyped("")
      setState(IDLE)
    }
  }, [open])

  const confirmDelete = useCallback(() => {
    if (state.phase === "deleting") return
    setState({ phase: "deleting" })

    request(() => client.api.projects[":id"].$delete({ param: { id: project.id } })).then(
      (result) => {
        if (!result.ok) {
          setState({ phase: "failed", error: result.error })
          return
        }
        navigate("/projects", { replace: true })
      },
    )
  }, [project.id, navigate, state.phase])

  if (!open) return null

  const armed = typed === project.slug
  const deleting = state.phase === "deleting"
  const sessionWord = project.sessionCount === 1 ? "session" : "sessions"

  return (
    <div className="fixed inset-0 z-30 flex items-start justify-center bg-ink/30 p-4 pt-16">
      <dialog
        ref={dialogRef}
        open
        aria-modal="true"
        aria-labelledby="delete-project-dialog-title"
        className="relative w-full max-w-md border border-rule bg-panel-2 p-6 text-ink shadow-overlay"
      >
        <h2
          id="delete-project-dialog-title"
          className="text-[1.375rem] font-semibold leading-tight"
        >
          Delete project
        </h2>
        <p className="mt-2 text-ink-soft">
          This destroys {project.sessionCount} {sessionWord} along with the project. This cannot be
          undone.
        </p>
        <p className="mt-4 text-ink-soft">
          Type <code className="font-mono text-[0.78rem] text-custody">{project.slug}</code> to
          confirm.
        </p>

        <input
          type="text"
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          aria-label="Project slug"
          autoComplete="off"
          className="mt-2 w-full border border-rule bg-panel px-3 py-2 font-mono text-[0.9375rem]"
        />

        <button
          type="button"
          onClick={confirmDelete}
          disabled={!armed || deleting}
          className="mt-4 border border-err/60 bg-panel px-3 py-2 text-[0.78rem] font-semibold text-err disabled:opacity-60"
        >
          {deleting ? "Deleting…" : "Delete project"}
        </button>

        {state.phase === "failed" ? (
          <p role="alert" className="mt-4 border border-err/40 bg-panel p-3 text-err">
            {failureMessage(state.error)}
          </p>
        ) : null}

        <button
          type="button"
          onClick={onClose}
          className="mt-6 block text-[0.78rem] font-semibold text-ink-soft underline"
        >
          Cancel
        </button>
      </dialog>
    </div>
  )
}
