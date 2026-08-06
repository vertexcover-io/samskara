import { useCallback, useEffect, useRef, useState } from "react"
import { useNavigate } from "react-router-dom"
import { PairingDialog } from "../account/PairingDialog.js"
import { logout } from "../api/account.js"
import type { ApiError, CurrentUser } from "../api/types.js"
import { useAuth } from "../auth/AuthProvider.js"

const ITEM_CLASS =
  "block w-full px-3 py-2 text-left text-[0.78rem] hover:bg-panel focus:bg-panel focus-visible:outline-none"

const itemsWithin = (menu: HTMLElement | null): ReadonlyArray<HTMLElement> =>
  menu ? Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]')) : []

const nextIndex = (key: string, current: number, count: number): number | null => {
  if (key === "ArrowDown") return current < 0 ? 0 : (current + 1) % count
  if (key === "ArrowUp") return current < 0 ? count - 1 : (current - 1 + count) % count
  if (key === "Home") return 0
  if (key === "End") return count - 1
  return null
}

const activeIndex = (items: ReadonlyArray<HTMLElement>): number => {
  const active = document.activeElement
  return active instanceof HTMLElement ? items.indexOf(active) : -1
}

export const AccountMenu = ({ user }: { user: CurrentUser }) => {
  const [open, setOpen] = useState(false)
  const [pairing, setPairing] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const navigate = useNavigate()
  const { clear } = useAuth()

  const close = useCallback(() => {
    setOpen(false)
    triggerRef.current?.focus()
  }, [])

  const focusTrigger = useCallback(() => triggerRef.current, [])

  useEffect(() => {
    if (!open) return
    itemsWithin(menuRef.current)[0]?.focus()
  }, [open])

  useEffect(() => {
    if (!open) return

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault()
        close()
        return
      }

      const items = itemsWithin(menuRef.current)
      if (items.length === 0) return

      const target = nextIndex(event.key, activeIndex(items), items.length)
      if (target === null) return
      event.preventDefault()
      items[target]?.focus()
    }

    const onPointerDown = (event: MouseEvent): void => {
      const target = event.target
      if (target instanceof Node && containerRef.current?.contains(target)) return
      setOpen(false)
    }

    document.addEventListener("keydown", onKeyDown)
    document.addEventListener("mousedown", onPointerDown)
    return () => {
      document.removeEventListener("keydown", onKeyDown)
      document.removeEventListener("mousedown", onPointerDown)
    }
  }, [open, close])

  const onPair = useCallback(() => {
    setOpen(false)
    setPairing(true)
  }, [])

  const onLogout = useCallback(() => {
    setError(null)
    logout().then((result) => {
      if (!result.ok) {
        setError(result.error)
        return
      }
      setOpen(false)
      clear()
      navigate("/login", { replace: true })
    })
  }, [clear, navigate])

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-label="Account menu"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
        className="border border-rule bg-panel-2 px-3 py-1.5 font-mono text-[0.78rem] text-ink-soft"
      >
        <span className="text-custody">signed in</span> / {user.githubLogin}
      </button>

      {open ? (
        <div
          ref={menuRef}
          role="menu"
          aria-label="Account"
          className="absolute right-0 z-20 mt-1 w-56 border border-rule bg-panel-2 py-1 shadow-[0_12px_32px_-14px_rgba(26,28,32,0.5)]"
        >
          <p className="border-b border-rule-soft px-3 py-2 font-mono text-[0.78rem] text-ink-soft">
            {user.githubLogin}
          </p>
          <button type="button" role="menuitem" onClick={onPair} className={ITEM_CLASS}>
            Pair the CLI
          </button>
          <button type="button" role="menuitem" onClick={onLogout} className={ITEM_CLASS}>
            Log out
          </button>
          {error ? (
            <p role="alert" className="border-t border-rule-soft px-3 py-2 text-[0.78rem] text-err">
              {error.message}
            </p>
          ) : null}
        </div>
      ) : null}

      <PairingDialog
        open={pairing}
        onClose={() => setPairing(false)}
        restoreFocusTo={focusTrigger}
      />
    </div>
  )
}
