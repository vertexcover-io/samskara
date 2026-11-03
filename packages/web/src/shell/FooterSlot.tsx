import { createContext, type ReactNode, useContext } from "react"
import { createPortal } from "react-dom"

const FooterSlotContext = createContext<HTMLElement | null>(null)

export const FooterSlotProvider = FooterSlotContext.Provider

/**
 * Renders its children into the app footer, which stays pinned to the bottom of the viewport for
 * as long as this is mounted, even while `children` is empty. Outside the shell it renders in place.
 */
export const InFooter = ({ children }: { readonly children: ReactNode }) => {
  const slot = useContext(FooterSlotContext)
  const content = <div className="mb-3 border-b border-rule-soft pb-3 empty:hidden">{children}</div>
  return slot === null ? content : createPortal(content, slot)
}
