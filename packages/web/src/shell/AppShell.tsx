import type { ReactNode } from "react"
import { Link, NavLink } from "react-router-dom"
import { useAuth } from "../auth/AuthProvider.js"
import { AccountMenu } from "./AccountMenu.js"
import { BuildStamp } from "./BuildStamp.js"

const NavItem = ({ to, children }: { to: string; children: ReactNode }) => (
  <NavLink
    to={to}
    className={({ isActive }) =>
      `text-[0.8125rem] font-semibold transition-colors ${
        isActive
          ? "text-ink underline decoration-stamp decoration-2 underline-offset-[6px]"
          : "text-ink-soft hover:text-ink"
      }`
    }
  >
    {children}
  </NavLink>
)

export const AppShell = ({ children }: { children: ReactNode }) => {
  const { user } = useAuth()

  return (
    <div className="relative z-10 flex min-h-dvh w-full flex-col">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-20 focus:rounded-xs focus:bg-panel-2 focus:px-3 focus:py-2"
      >
        Skip to content
      </a>

      <header className="border-b border-rule bg-panel-2/80 px-4 py-3 sm:px-6">
        <div className="mx-auto flex max-w-[1440px] flex-wrap items-center justify-between gap-x-6 gap-y-2">
          <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
            <Link to="/projects" className="text-[1.375rem] font-semibold leading-tight">
              samskara
            </Link>
            {user ? (
              <nav aria-label="Primary" className="flex items-center gap-4">
                <NavItem to="/projects">Projects</NavItem>
                <NavItem to="/sessions">Sessions</NavItem>
                <NavItem to="/learnings">Lessons</NavItem>
                <NavItem to="/sync-status">Sync</NavItem>
              </nav>
            ) : null}
          </div>
          {user ? <AccountMenu user={user} /> : null}
        </div>
      </header>

      <main id="main" className="mx-auto w-full max-w-[1440px] flex-1 px-4 py-6 sm:px-6">
        {children}
      </main>

      <footer className="border-t border-rule-soft bg-panel-2/60 px-4 py-3 sm:px-6">
        <div className="mx-auto flex max-w-[1440px] flex-wrap items-center justify-between gap-x-6 gap-y-2">
          <p className="text-label uppercase text-ink-soft">samskara</p>
          <BuildStamp />
        </div>
      </footer>
    </div>
  )
}
