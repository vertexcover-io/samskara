import type { ReactNode } from "react"
import { Navigate } from "react-router-dom"
import { LoadingShell } from "../shell/LoadingShell.js"
import { useAuth } from "./AuthProvider.js"

export const RequireAuth = ({ children }: { children: ReactNode }) => {
  const { status } = useAuth()

  if (status === "loading") return <LoadingShell label="Verifying your session" />
  if (status === "anon") return <Navigate to="/login" replace />
  return <>{children}</>
}
