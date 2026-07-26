import { useCallback, useEffect, useRef, useState } from "react"

export type FocusMode = {
  readonly focusedId: string | null
  readonly open: (id: string, trigger: HTMLElement) => void
  readonly exit: () => void
}

export const useFocusMode = (): FocusMode => {
  const [focusedId, setFocusedId] = useState<string | null>(null)
  const trigger = useRef<HTMLElement | null>(null)

  const open = useCallback((id: string, element: HTMLElement) => {
    trigger.current = element
    setFocusedId(id)
  }, [])

  const exit = useCallback(() => {
    const restoreTo = trigger.current
    trigger.current = null
    setFocusedId(null)
    if (restoreTo?.isConnected) restoreTo.focus()
  }, [])

  useEffect(() => {
    if (focusedId === null) return

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return
      event.preventDefault()
      exit()
    }

    document.addEventListener("keydown", onKeyDown)
    return () => document.removeEventListener("keydown", onKeyDown)
  }, [focusedId, exit])

  return { focusedId, open, exit }
}
