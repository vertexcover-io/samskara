import type { ReactNode } from "react"

const chipClass = "rounded-pill border border-rule px-2 py-0.5"

type Props = {
  readonly children: ReactNode
  readonly onRemove?: () => void
  readonly removeLabel?: string
}

export const Chip = ({ children, onRemove, removeLabel }: Props) =>
  onRemove === undefined ? (
    <span className={chipClass}>{children}</span>
  ) : (
    <span className={`${chipClass} inline-flex items-center gap-1`}>
      {children}
      <button
        type="button"
        aria-label={removeLabel}
        onClick={onRemove}
        className="text-ink-soft hover:text-ink"
      >
        <svg
          viewBox="0 0 12 12"
          aria-hidden="true"
          className="h-2 w-2 fill-none stroke-current stroke-[1.6]"
        >
          <path d="M1 1l10 10M11 1 1 11" strokeLinecap="round" />
        </svg>
      </button>
    </span>
  )
