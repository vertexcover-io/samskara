import { useCallback, useEffect, useRef } from "react"

export type FocusMode = {
  readonly open: (id: string, trigger: HTMLElement | null) => void
  readonly exit: () => void
}

/**
 * Which branch is open belongs to the caller -- the session view keeps it in the URL so a branch
 * can be shared. What lives here is the focus contract around it: remember the control that
 * opened the branch, close on Escape, and hand focus back to where it came from.
 */
export const useFocusMode = (
  focusedId: string | null,
  onChange: (next: string | null) => void,
): FocusMode => {
  const trigger = useRef<HTMLElement | null>(null)

  // A branch opened from a shared link has no originating element to restore focus to.
  const open = useCallback(
    (id: string, element: HTMLElement | null) => {
      trigger.current = element
      onChange(id)
    },
    [onChange],
  )

  const exit = useCallback(() => {
    const restoreTo = trigger.current
    trigger.current = null
    onChange(null)
    if (restoreTo?.isConnected) restoreTo.focus()
  }, [onChange])

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

  return { open, exit }
}
