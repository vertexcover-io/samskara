import { useCallback, useEffect, useRef, useState } from "react"
import { requestPairingCode } from "../api/account.js"
import type { ApiError } from "../api/types.js"
import { absoluteTime } from "../time.js"
import { copyText } from "./copyText.js"
import { useFocusTrap } from "./useFocusTrap.js"

const TTL_MS = 5 * 60 * 1000

type State =
  | { readonly phase: "ready" }
  | { readonly phase: "generating" }
  | { readonly phase: "ready-code"; readonly code: string; readonly expiresAt: number }
  | { readonly phase: "expired" }
  | { readonly phase: "failed"; readonly error: ApiError }

const READY: State = { phase: "ready" }

const Label = ({ children }: { children: string }) => (
  <p className="text-[0.656rem] font-semibold uppercase tracking-[0.12em] text-ink-soft">
    {children}
  </p>
)

const CodePanel = ({ code, expiresAt }: { code: string; expiresAt: number }) => {
  const [copied, setCopied] = useState(false)

  const onCopy = useCallback(() => {
    copyText(code).then(setCopied)
  }, [code])

  return (
    <div className="mt-4 border border-rule bg-panel p-4">
      <Label>Pairing code</Label>
      <p
        data-testid="pairing-code"
        className="mt-1 break-all font-mono text-[0.9375rem] tabular-nums text-custody"
      >
        {code}
      </p>
      <p className="mt-2 text-ink-soft">
        Expires{" "}
        <span className="font-mono text-[0.78rem] tabular-nums">{absoluteTime(expiresAt)}</span>
      </p>
      <button
        type="button"
        onClick={onCopy}
        className="mt-3 border border-rule bg-panel-2 px-3 py-2 text-[0.78rem] font-semibold"
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  )
}

type Props = {
  readonly open: boolean
  readonly onClose: () => void
  readonly restoreFocusTo?: () => HTMLElement | null
}

export const PairingDialog = ({ open, onClose, restoreFocusTo }: Props) => {
  const [state, setState] = useState<State>(READY)
  const pending = useRef(false)
  const dialogRef = useFocusTrap<HTMLDialogElement>({
    active: open,
    onEscape: onClose,
    fallbackFocus: restoreFocusTo,
  })

  useEffect(() => {
    if (!open) {
      pending.current = false
      setState(READY)
    }
  }, [open])

  useEffect(() => {
    if (state.phase !== "ready-code") return
    const remaining = state.expiresAt - Date.now()
    const timer = setTimeout(() => setState({ phase: "expired" }), Math.max(remaining, 0))
    return () => clearTimeout(timer)
  }, [state])

  const generate = useCallback(() => {
    if (pending.current) return
    pending.current = true
    setState({ phase: "generating" })

    requestPairingCode().then((result) => {
      pending.current = false
      setState(
        result.ok
          ? { phase: "ready-code", code: result.data.code, expiresAt: Date.now() + TTL_MS }
          : { phase: "failed", error: result.error },
      )
    })
  }, [])

  if (!open) return null

  const generating = state.phase === "generating"
  const actionLabel = state.phase === "failed" ? "Try again" : "Generate code"

  return (
    <div className="fixed inset-0 z-30 flex items-start justify-center bg-ink/30 p-4 pt-16">
      <dialog
        ref={dialogRef}
        open
        aria-modal="true"
        aria-labelledby="pairing-dialog-title"
        className="relative w-full max-w-md border border-rule bg-panel-2 p-6 text-ink shadow-overlay"
      >
        <h2 id="pairing-dialog-title" className="text-[1.375rem] font-semibold leading-tight">
          Pair the CLI
        </h2>
        <p className="mt-2 text-ink-soft">
          Generate a one-time code, then run{" "}
          <code className="font-mono text-[0.78rem] text-custody">samskara login</code> and paste
          it.
        </p>

        <button
          type="button"
          onClick={generate}
          disabled={generating}
          className="mt-4 border border-rule bg-panel px-3 py-2 text-[0.78rem] font-semibold disabled:opacity-60"
        >
          {generating ? "Generating…" : actionLabel}
        </button>

        {state.phase === "ready-code" ? (
          <CodePanel code={state.code} expiresAt={state.expiresAt} />
        ) : null}

        {state.phase === "expired" ? (
          <output className="mt-4 block border border-warn/40 bg-panel p-3 text-warn">
            That code expired. Generate a new one.
          </output>
        ) : null}

        {state.phase === "failed" ? (
          <p role="alert" className="mt-4 border border-err/40 bg-panel p-3 text-err">
            {state.error.message}
          </p>
        ) : null}

        <button
          type="button"
          onClick={onClose}
          className="mt-6 block text-[0.78rem] font-semibold text-ink-soft underline"
        >
          Close
        </button>
      </dialog>
    </div>
  )
}
