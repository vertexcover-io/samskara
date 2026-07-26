import { type RefObject, useEffect, useRef } from "react"

const FOCUSABLE =
  'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

const focusableWithin = (root: HTMLElement): ReadonlyArray<HTMLElement> =>
  Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE))

const wrapTarget = (
  items: ReadonlyArray<HTMLElement>,
  active: Element | null,
  backwards: boolean,
): HTMLElement | null => {
  const first = items[0]
  const last = items[items.length - 1]
  if (!first || !last) return null
  if (backwards && active === first) return last
  if (!backwards && active === last) return first
  return null
}

type Options = {
  readonly active: boolean
  readonly onEscape: () => void
  readonly fallbackFocus?: () => HTMLElement | null
}

const isRestorable = (element: HTMLElement | null): element is HTMLElement =>
  element !== null && element !== document.body && element.isConnected

const restoreFocus = (saved: HTMLElement | null, fallback: HTMLElement | null): void => {
  if (isRestorable(saved)) {
    saved.focus()
    return
  }
  fallback?.focus()
}

export const useFocusTrap = <T extends HTMLElement>({
  active,
  onEscape,
  fallbackFocus,
}: Options): RefObject<T> => {
  const ref = useRef<T>(null)
  const restoreTo = useRef<HTMLElement | null>(null)
  const fallback = useRef(fallbackFocus)
  fallback.current = fallbackFocus

  useEffect(() => {
    const container = ref.current
    if (!active || !container) return

    restoreTo.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    focusableWithin(container)[0]?.focus()

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault()
        onEscape()
        return
      }
      if (event.key !== "Tab") return

      const target = wrapTarget(focusableWithin(container), document.activeElement, event.shiftKey)
      if (!target) return
      event.preventDefault()
      target.focus()
    }

    document.addEventListener("keydown", onKeyDown)
    return () => {
      document.removeEventListener("keydown", onKeyDown)
      restoreFocus(restoreTo.current, fallback.current?.() ?? null)
    }
  }, [active, onEscape])

  return ref
}
