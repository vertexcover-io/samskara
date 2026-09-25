import { useRef } from "react"

export type TabId = "conversation" | "tools" | "artifacts" | "commits" | "pulls" | "review"

export type Tab = {
  readonly id: TabId
  readonly label: string
  readonly count: number
}

const nextIndex = (key: string, current: number, total: number): number | null => {
  if (key === "ArrowRight") return (current + 1) % total
  if (key === "ArrowLeft") return (current - 1 + total) % total
  if (key === "Home") return 0
  if (key === "End") return total - 1
  return null
}

type Props = {
  readonly tabs: ReadonlyArray<Tab>
  readonly selected: TabId
  readonly onSelect: (id: TabId) => void
}

export const Tabs = ({ tabs, selected, onSelect }: Props) => {
  const refs = useRef(new Map<TabId, HTMLButtonElement>())

  const move = (key: string, from: number): void => {
    const target = nextIndex(key, from, tabs.length)
    if (target === null) return
    const tab = tabs[target]
    if (!tab) return
    onSelect(tab.id)
    refs.current.get(tab.id)?.focus()
  }

  return (
    <div
      role="tablist"
      aria-label="Session views"
      className="flex gap-0.5 overflow-x-auto border-b border-rule"
    >
      {tabs.map((tab, index) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          id={`tab-${tab.id}`}
          aria-selected={tab.id === selected}
          aria-controls={`panel-${tab.id}`}
          tabIndex={tab.id === selected ? 0 : -1}
          ref={(node) => {
            if (node) refs.current.set(tab.id, node)
            else refs.current.delete(tab.id)
          }}
          onClick={() => onSelect(tab.id)}
          onKeyDown={(event) => {
            const target = nextIndex(event.key, index, tabs.length)
            if (target === null) return
            event.preventDefault()
            move(event.key, index)
          }}
          className={`relative top-px inline-flex shrink-0 items-center gap-2 border border-transparent border-b-0 px-3 py-3 text-[0.78rem] font-semibold uppercase tracking-[0.06em] transition-colors ${
            tab.id === selected
              ? "rounded-t-sm border-rule bg-panel text-ink before:absolute before:inset-x-0 before:-top-px before:h-[3px] before:rounded-t-sm before:bg-stamp"
              : "text-ink-soft hover:text-ink"
          }`}
        >
          {tab.label}
          <span className="font-mono text-[0.6875rem] font-normal tracking-normal text-faded">
            {tab.count}
          </span>
        </button>
      ))}
    </div>
  )
}
