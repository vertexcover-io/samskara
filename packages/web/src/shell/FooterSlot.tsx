import { createContext, type ReactNode, useContext, useEffect } from "react"
import { createPortal } from "react-dom"

const FooterSlotContext = createContext<HTMLElement | null>(null)

export const FooterSlotProvider = FooterSlotContext.Provider

/**
 * Publishes the footer's rendered height on the root element as `--footer-height`, which the
 * pinned footer's `scroll-padding-bottom` reads (index.css). The height changes with the viewport
 * width and with what the slot holds, so it is measured rather than hard-coded.
 */
export const usePublishedFooterHeight = (footer: HTMLElement | null) => {
  useEffect(() => {
    if (footer === null) return
    const root = document.documentElement
    const publish = () =>
      root.style.setProperty("--footer-height", `${footer.getBoundingClientRect().height}px`)
    publish()
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(publish)
    observer?.observe(footer)
    return () => {
      observer?.disconnect()
      root.style.removeProperty("--footer-height")
    }
  }, [footer])
}

/**
 * Renders its children into the app footer, which stays pinned to the bottom of the viewport for
 * as long as this is mounted, even while `children` is empty. Outside the shell it renders in place.
 */
export const InFooter = ({ children }: { readonly children: ReactNode }) => {
  const slot = useContext(FooterSlotContext)
  const content = <div className="mb-3 border-b border-rule-soft pb-3 empty:hidden">{children}</div>
  return slot === null ? content : createPortal(content, slot)
}
