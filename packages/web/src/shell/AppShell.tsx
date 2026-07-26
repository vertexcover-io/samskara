import type { ReactNode } from "react"
import { useAuth } from "../auth/AuthProvider.js"
import { AccountMenu } from "./AccountMenu.js"

export const AppShell = ({ children }: { children: ReactNode }) => {
  const { user } = useAuth()

  return (
    <div className="relative z-10 min-h-dvh w-full">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-20 focus:rounded-xs focus:bg-panel-2 focus:px-3 focus:py-2"
      >
        Skip to content
      </a>

      <header className="border-b border-rule bg-panel-2/80 px-4 py-3 sm:px-6">
        <div className="mx-auto flex max-w-6xl flex-wrap items-baseline justify-between gap-2">
          <p className="text-[1.375rem] font-semibold leading-tight">samskara</p>
          {user ? <AccountMenu user={user} /> : null}
        </div>
      </header>

      <main id="main" className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6">
        {children}
      </main>
    </div>
  )
}
