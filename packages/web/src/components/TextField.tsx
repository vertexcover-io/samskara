import { type ReactNode, useId } from "react"

/**
 * The filter control's look, defined once. Two surfaces render a labelled text input -- the
 * sessions filter bar and the sync status table -- and they had drifted into two copies of the
 * same class strings.
 */
export const controlClass =
  "mt-1 h-9 w-full min-w-0 rounded-xs border border-rule bg-panel-2 px-2 font-mono text-[0.78rem] leading-none text-ink transition-colors hover:border-ink-soft focus-visible:border-custody"
export const labelClass =
  "block text-[0.656rem] font-semibold uppercase tracking-[0.12em] text-ink-soft"

type Props = {
  readonly label: string
  readonly value: string
  readonly onChange: (value: string) => void
  readonly placeholder?: string
  readonly hint?: string
  /**
   * Rendered beside the input. A filter that costs a request puts its Apply button here; a filter
   * that runs in the browser leaves it empty and narrows as the reader types.
   */
  readonly trailing?: ReactNode
}

/**
 * Renders a label bound to its input, and nothing around them. The caller supplies the wrapper,
 * because one surface needs a form and the other needs a plain div.
 */
export const TextField = ({ label, value, onChange, placeholder, hint, trailing }: Props) => {
  const id = useId()
  const hintId = `${id}-hint`

  return (
    <>
      <label className={labelClass} htmlFor={id}>
        {label}
      </label>
      <div className="mt-1 flex gap-1.5">
        <input
          id={id}
          className={`${controlClass} mt-0`}
          value={value}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
          aria-describedby={hint === undefined ? undefined : hintId}
        />
        {trailing}
      </div>
      {hint === undefined ? null : (
        <span id={hintId} className="sr-only">
          {hint}
        </span>
      )}
    </>
  )
}
