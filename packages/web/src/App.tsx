import type { ReactNode } from "react"
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom"
import { AuthProvider, useAuth } from "./auth/AuthProvider.js"
import { RequireAuth } from "./auth/RequireAuth.js"
import { Login } from "./routes/Login.js"
import { OrgDetail } from "./routes/OrgDetail.js"
import { Orgs } from "./routes/Orgs.js"
import { ProjectDetail } from "./routes/ProjectDetail.js"
import { Projects } from "./routes/Projects.js"
import { SessionDetail } from "./routes/SessionDetail.js"
import { Sessions } from "./routes/Sessions.js"
import { SyncStatus } from "./routes/SyncStatus.js"
import { AppShell } from "./shell/AppShell.js"
import { LoadingShell } from "./shell/LoadingShell.js"

const LoginRoute = () => {
  const { status } = useAuth()

  if (status === "loading") return <LoadingShell label="Verifying your session" />
  if (status === "authed") return <Navigate to="/projects" replace />
  return <Login />
}

const Protected = ({ children }: { children: ReactNode }) => (
  <RequireAuth>
    <AppShell>{children}</AppShell>
  </RequireAuth>
)

export const AppRoutes = () => (
  <Routes>
    <Route path="/login" element={<LoginRoute />} />
    <Route
      path="/projects"
      element={
        <Protected>
          <Projects />
        </Protected>
      }
    />
    <Route
      path="/projects/:id"
      element={
        <Protected>
          <ProjectDetail />
        </Protected>
      }
    />
    <Route
      path="/orgs"
      element={
        <Protected>
          <Orgs />
        </Protected>
      }
    />
    <Route
      path="/orgs/:slug"
      element={
        <Protected>
          <OrgDetail />
        </Protected>
      }
    />
    <Route
      path="/sync-status"
      element={
        <Protected>
          <SyncStatus />
        </Protected>
      }
    />
    <Route
      path="/sessions"
      element={
        <Protected>
          <Sessions />
        </Protected>
      }
    />
    <Route
      path="/sessions/:sessionId"
      element={
        <Protected>
          <SessionDetail />
        </Protected>
      }
    />
    <Route path="*" element={<Navigate to="/projects" replace />} />
  </Routes>
)

export const App = () => (
  <AuthProvider>
    <BrowserRouter>
      <AppRoutes />
    </BrowserRouter>
  </AuthProvider>
)
