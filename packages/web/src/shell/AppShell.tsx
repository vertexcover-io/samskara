import { type ReactNode, useState } from "react"
import { Link, NavLink } from "react-router-dom"
import { useAuth } from "../auth/AuthProvider.js"
import { AccountMenu } from "./AccountMenu.js"
import { BuildStamp } from "./BuildStamp.js"
import { FooterSlotProvider, usePublishedFooterHeight } from "./FooterSlot.js"

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
  const [footerSlot, setFooterSlot] = useState<HTMLElement | null>(null)
  const [footer, setFooter] = useState<HTMLElement | null>(null)
  usePublishedFooterHeight(footer)

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
                <NavItem to="/learnings">Fixes</NavItem>
                <NavItem to="/learn-events">Compound learning evaluation</NavItem>
                <NavItem to="/orgs">Orgs</NavItem>
                <NavItem to="/sync-status">Sync</NavItem>
              </nav>
            ) : null}
          </div>
          {user ? <AccountMenu user={user} /> : null}
        </div>
      </header>

      <main id="main" className="mx-auto w-full max-w-[1440px] flex-1 px-4 py-6 sm:px-6">
        <FooterSlotProvider value={footerSlot}>{children}</FooterSlotProvider>
      </main>

      {/* Pinned only while a page has put something in the slot: a long page then keeps its footer
          on screen, and every other page leaves it at the end of the document. z-10 keeps it over
          the page's rows but under the z-20 filter and account menus, which may open down into it. */}
      <footer
        ref={setFooter}
        className="border-t border-rule-soft bg-panel-2/60 px-4 py-3 sm:px-6 has-[[data-footer-slot]>*]:sticky has-[[data-footer-slot]>*]:bottom-0 has-[[data-footer-slot]>*]:z-10 has-[[data-footer-slot]>*]:bg-panel-2"
      >
        <div ref={setFooterSlot} data-footer-slot className="mx-auto max-w-[1440px]" />
        <div className="mx-auto flex max-w-[1440px] flex-wrap items-center justify-between gap-x-6 gap-y-2">
          <p className="text-label uppercase text-ink-soft">samskara</p>
          <BuildStamp />
        </div>
      </footer>
    </div>
  )
}
