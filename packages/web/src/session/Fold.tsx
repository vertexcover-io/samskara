import { type ReactNode, type RefObject, useEffect, useId, useRef, useState } from "react"

const LONG_LINES = 30
const LONG_CHARS = 2500

export const isLong = (text: string): boolean =>
  text.length > LONG_CHARS || text.split("\n").length > LONG_LINES

type ToggleProps = {
  readonly open: boolean
  readonly controls: string
  readonly onToggle: () => void
  readonly buttonRef?: RefObject<HTMLButtonElement>
}

const Toggle = ({ open, controls, onToggle, buttonRef }: ToggleProps) => (
  <button
    ref={buttonRef}
    type="button"
    aria-expanded={open}
    aria-controls={controls}
    onClick={onToggle}
    className="inline-flex items-center gap-1 rounded-xs px-1 py-0.5 text-[0.75rem] font-semibold text-ink-soft hover:bg-panel hover:text-ink active:bg-rule-soft"
  >
    <span aria-hidden="true">{open ? "⌃" : "⌄"}</span>
    {open ? "Collapse message" : "Show full message"}
  </button>
)

type Props = {
  readonly long: boolean
  readonly linked: boolean
  readonly anchor: string
  readonly children: ReactNode
}

export const Fold = ({ long, linked, anchor, children }: Props) => {
  const [open, setOpen] = useState(true)
  const collapsing = useRef(false)
  const bottom = useRef<HTMLButtonElement>(null)
  const bodyId = useId()

  useEffect(() => {
    if (linked) setOpen(true)
  }, [linked])

  // Scrolling in the click handler would measure the body before React shrinks it.
  useEffect(() => {
    if (open || !collapsing.current) return
    collapsing.current = false
    bottom.current?.focus({ preventScroll: true })
    const record = document.getElementById(anchor)
    if (record === null) return
    const head = Number.parseFloat(getComputedStyle(record).getPropertyValue("--sticky-head")) || 0
    if (record.getBoundingClientRect().top >= head) return
    record.scrollIntoView({ block: "start" })
  }, [open, anchor])

  if (!long) return <>{children}</>

  const toggle = (): void => {
    collapsing.current = open
    setOpen(!open)
  }

  return (
    <div>
      {open ? (
        <div className="mb-1 flex justify-end">
          <Toggle open={open} controls={bodyId} onToggle={toggle} />
        </div>
      ) : null}
      {/* Opening on keyboard focus keeps Tab off a link clipped out of view; a mouse press is left
          alone, since opening mid-click moves the link before the click lands. */}
      {/* biome-ignore lint/a11y/useSemanticElements: a plain div grouping the message body, not a form */}
      <div
        id={bodyId}
        role="group"
        onFocus={(event) => {
          if (event.target.matches(":focus-visible")) setOpen(true)
        }}
        className={open ? undefined : "relative max-h-48 overflow-hidden"}
      >
        {children}
        {open ? null : (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-linear-to-b from-transparent to-panel-2"
          />
        )}
      </div>
      <div className="mt-1">
        <Toggle open={open} controls={bodyId} onToggle={toggle} buttonRef={bottom} />
      </div>
    </div>
  )
}
