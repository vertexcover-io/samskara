import { type ReactNode, createContext, useCallback, useContext, useEffect, useState } from "react"
import { getJson } from "../api/client.js"
import { parseCurrentUser } from "../api/parse.js"
import type { CurrentUser } from "../api/types.js"

export type AuthStatus = "loading" | "authed" | "anon"

export type Auth = {
  readonly status: AuthStatus
  readonly user: CurrentUser | null
  readonly refresh: () => void
  readonly clear: () => void
}

type AuthState = {
  readonly status: AuthStatus
  readonly user: CurrentUser | null
}

const LOADING: AuthState = { status: "loading", user: null }
const ANON: AuthState = { status: "anon", user: null }

const AuthContext = createContext<Auth | null>(null)

const resolveSession = (): Promise<AuthState> =>
  getJson("/api/auth/me", parseCurrentUser).then((result) =>
    result.ok ? { status: "authed", user: result.data } : ANON,
  )

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const [state, setState] = useState<AuthState>(LOADING)

  useEffect(() => {
    let active = true
    resolveSession().then((resolved) => {
      if (active) setState(resolved)
    })
    return () => {
      active = false
    }
  }, [])

  const refresh = useCallback(() => {
    setState(LOADING)
    resolveSession().then(setState)
  }, [])

  const clear = useCallback(() => setState(ANON), [])

  return (
    <AuthContext.Provider value={{ ...state, refresh, clear }}>{children}</AuthContext.Provider>
  )
}

export const useAuth = (): Auth => {
  const auth = useContext(AuthContext)
  if (!auth) throw new Error("useAuth must be used inside AuthProvider")
  return auth
}
