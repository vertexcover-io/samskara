import { useEffect, useId, useRef, useState } from "react"
import {
  RANGES,
  RANGE_LABEL,
  type Range,
  SORTS,
  SORT_LABEL,
  type SessionFilters,
  type Sort,
} from "../sessions/filters.js"
import { useDebouncedValue } from "../sessions/useDebouncedValue.js"

const asRange = (value: string): Range => RANGES.find((range) => range === value) ?? "all"
const asSort = (value: string): Sort => SORTS.find((sort) => sort === value) ?? "recent"

// Native controls do not inherit type, so the font stack is set explicitly.
const controlClass =
  "mt-1 h-9 w-full min-w-0 rounded-xs border border-rule bg-panel-2 px-2 font-mono text-[0.78rem] leading-none text-ink transition-colors hover:border-ink-soft focus-visible:border-custody"

const selectClass = `${controlClass} mt-0 cursor-pointer appearance-none pr-7`

const labelClass = "block text-[0.656rem] font-semibold uppercase tracking-[0.12em] text-ink-soft"

/**
 * A child rather than a background image: an inline `url()` cannot survive a Tailwind arbitrary
 * value (its spaces split the class list), and drawing it here lets the caret take `currentColor`.
 */
const Caret = () => (
  <svg
    viewBox="0 0 12 8"
    aria-hidden="true"
    className="pointer-events-none absolute right-2 top-1/2 h-2 w-3 -translate-y-1/2 fill-none stroke-current stroke-[1.6] text-ink-soft"
  >
    <path d="M1 1.5 6 6.5l5-5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

export type Option = { readonly value: string; readonly label: string }

type ChoiceProps = {
  readonly label: string
  readonly value: string
  readonly options: ReadonlyArray<Option>
  readonly onChange: (value: string) => void
}

const Choice = ({ label, value, options, onChange }: ChoiceProps) => {
  const id = useId()

  return (
    <div className="min-w-0">
      <label className={labelClass} htmlFor={id}>
        {label}
      </label>
      <div className="relative mt-1">
        <select
          id={id}
          className={selectClass}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <Caret />
      </div>
    </div>
  )
}

// Local state carries every keystroke immediately; onChange only fires once the debounced
// value settles, so typing costs one URL write instead of one per keystroke.
const SearchControl = ({
  filters,
  onChange,
}: {
  filters: SessionFilters
  onChange: (filters: SessionFilters) => void
}) => {
  const id = useId()
  const [text, setText] = useState(filters.q ?? "")
  const debounced = useDebouncedValue(text, 250)
  const committed = useRef(filters.q)

  useEffect(() => {
    setText(filters.q ?? "")
    committed.current = filters.q
  }, [filters.q])

  useEffect(() => {
    const next = debounced.trim() === "" ? null : debounced
    if (next === committed.current) return
    committed.current = next
    onChange({ ...filters, q: next })
  }, [debounced, filters, onChange])

  return (
    <div className="min-w-0">
      <label className={labelClass} htmlFor={id}>
        Keyword
      </label>
      <input
        id={id}
        type="search"
        value={text}
        placeholder="Search transcripts…"
        className={controlClass}
        onChange={(event) => setText(event.target.value)}
      />
    </div>
  )
}

const withAny = (options: ReadonlyArray<Option>, anyLabel: string): ReadonlyArray<Option> => [
  { value: "", label: anyLabel },
  ...options,
]

// Two date inputs need the room of two controls, and the range keeps that width in either state so
// switching to a custom window does not reflow the bar around it.
const RANGE_SPAN = "min-w-0 min-[560px]:col-span-2"

// Choosing a custom window replaces the range select in place rather than
// appending a control, so the bar never reflows.
const RangeControl = ({
  filters,
  onChange,
}: {
  filters: SessionFilters
  onChange: (filters: SessionFilters) => void
}) => {
  const id = useId()

  if (filters.range !== "custom") {
    return (
      <div className={RANGE_SPAN}>
        <Choice
          label="Last active"
          value={filters.range}
          options={RANGES.map((range) => ({ value: range, label: RANGE_LABEL[range] }))}
          onChange={(range) => onChange({ ...filters, range: asRange(range) })}
        />
      </div>
    )
  }

  return (
    <div className={RANGE_SPAN}>
      <div className="flex items-baseline justify-between gap-2">
        <label className={labelClass} htmlFor={id}>
          Last active
        </label>
        <button
          type="button"
          onClick={() => onChange({ ...filters, range: "all", from: null, to: null })}
          className="text-[0.625rem] font-semibold uppercase tracking-[0.1em] text-custody hover:underline"
        >
          Reset
        </button>
      </div>
      <div className="mt-1 flex min-w-0 items-center gap-1.5">
        <input
          id={id}
          type="date"
          value={filters.from ?? ""}
          max={filters.to ?? undefined}
          aria-label="From date"
          className={`${controlClass} mt-0`}
          onChange={(event) =>
            onChange({ ...filters, from: event.target.value === "" ? null : event.target.value })
          }
        />
        <span aria-hidden="true" className="shrink-0 font-mono text-[0.72rem] text-faded">
          →
        </span>
        <input
          type="date"
          value={filters.to ?? ""}
          min={filters.from ?? undefined}
          aria-label="To date"
          className={`${controlClass} mt-0`}
          onChange={(event) =>
            onChange({ ...filters, to: event.target.value === "" ? null : event.target.value })
          }
        />
      </div>
    </div>
  )
}

type Props = {
  readonly filters: SessionFilters
  readonly projects: ReadonlyArray<Option>
  readonly users: ReadonlyArray<string>
  readonly onChange: (filters: SessionFilters) => void
}

export const FilterBar = ({ filters, projects, users, onChange }: Props) => (
  <section
    aria-label="Session filters"
    className="grid grid-cols-1 items-end gap-3 border border-rule bg-panel p-3 min-[560px]:grid-cols-2 min-[900px]:grid-cols-6"
  >
    <SearchControl filters={filters} onChange={onChange} />
    <Choice
      label="Project"
      value={filters.project ?? ""}
      options={withAny(projects, "All projects")}
      onChange={(project) => onChange({ ...filters, project: project === "" ? null : project })}
    />
    <Choice
      label="User"
      value={filters.user ?? ""}
      options={withAny(
        users.map((user) => ({ value: user, label: user })),
        "All users",
      )}
      onChange={(user) => onChange({ ...filters, user: user === "" ? null : user })}
    />
    <RangeControl filters={filters} onChange={onChange} />

    <Choice
      label="Sort by"
      value={filters.sort}
      options={SORTS.map((sort) => ({ value: sort, label: SORT_LABEL[sort] }))}
      onChange={(sort) => onChange({ ...filters, sort: asSort(sort) })}
    />
  </section>
)
