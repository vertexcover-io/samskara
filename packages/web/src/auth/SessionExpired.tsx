import { useEffect } from "react"
import { Navigate } from "react-router-dom"
import { useAuth } from "./AuthProvider.js"

export const SessionExpired = () => {
  const { status, clear } = useAuth()

  useEffect(() => {
    if (status === "authed") clear()
  }, [status, clear])

  return <Navigate to="/login" replace />
}
