import { useEffect, useId, useState } from "react"
import { fetchAuthMethods, localLogin } from "../api/account.js"
import type { ApiError } from "../api/client.js"
import { controlClass, labelClass } from "../components/TextField.js"

export type SignInMethods = { readonly github: boolean; readonly local: boolean }

/** Assumed until /methods answers, so the usual deployment paints its button immediately. */
const ASSUMED: SignInMethods = { github: true, local: false }

export const useAuthMethods = (): SignInMethods => {
  const [methods, setMethods] = useState(ASSUMED)

  useEffect(() => {
    let active = true
    fetchAuthMethods().then((result) => {
      if (active && result.ok) setMethods({ github: result.data.github, local: result.data.local })
    })
    return () => {
      active = false
    }
  }, [])

  return methods
}

type FormState =
  | { readonly phase: "ready" }
  | { readonly phase: "signing-in" }
  | { readonly phase: "failed"; readonly message: string }

const READY: FormState = { phase: "ready" }

const errorText = (error: ApiError): string => {
  if (error.kind === "unauthorized") return "That secret did not match."
  if (error.code === "unknown_user")
    return "No seeded user to sign in as — run `bun run seed` first."
  if (error.kind === "notFound") return "Local sign-in is not available."
  return error.message
}

const reload = (path: string): void => window.location.assign(path)

export const LocalSecretForm = ({
  onSignedIn = reload,
}: {
  readonly onSignedIn?: (path: string) => void
}) => {
  const [secret, setSecret] = useState("")
  const [state, setState] = useState<FormState>(READY)
  const secretId = useId()

  const signIn = () => {
    if (state.phase === "signing-in") return
    setState({ phase: "signing-in" })
    localLogin(secret).then((result) => {
      if (result.ok) {
        onSignedIn("/")
        return
      }
      setState({ phase: "failed", message: errorText(result.error) })
    })
  }

  return (
    <form
      className="mt-6"
      onSubmit={(event) => {
        event.preventDefault()
        signIn()
      }}
    >
      <label className={labelClass} htmlFor={secretId}>
        Local secret
      </label>
      <input
        id={secretId}
        type="password"
        autoComplete="current-password"
        className={controlClass}
        value={secret}
        onChange={(event) => {
          setSecret(event.target.value)
          if (state.phase === "failed") setState(READY)
        }}
      />
      <button
        type="submit"
        disabled={state.phase === "signing-in" || secret.length === 0}
        className="mt-2 w-full rounded-xs border border-ink px-4 py-2.5 text-[0.78rem] font-semibold text-ink transition-colors hover:bg-ink hover:text-panel-2 disabled:opacity-60"
      >
        {state.phase === "signing-in" ? "Signing in…" : "Sign in with local secret"}
      </button>
      {state.phase === "failed" ? (
        <p role="alert" className="mt-3 text-[0.78rem] text-err">
          {state.message}
        </p>
      ) : null}
    </form>
  )
}
